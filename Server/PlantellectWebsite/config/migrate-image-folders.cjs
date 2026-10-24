/**
 * Photo-folder migration.   node config/migrate-image-folders.cjs [--dry-run]
 *
 * Idempotent and non-destructive. Run it TWICE in a row: the second run should
 * report nothing left to do.
 *
 *   1. Adds fileIssue / fileIssueAt to plant_images and discovery_images
 *      (what the plants page reads to tell an admin a photo could not be filed).
 *   2. Creates plants/ and discoveries/ with pending, approved and denied.
 *   3. Moves every existing photo into the folder its status belongs in, with the
 *      same copy -> verify -> delete-the-source rule the live code uses (up to 5
 *      attempts per photo). A photo that cannot be copied cleanly is LEFT WHERE IT
 *      IS, flagged in fileIssue, and listed at the end. Nothing is ever deleted
 *      unless its verified copy exists and the database points at the copy.
 *   4. Removes legacy folders (plant-images/<plantId>, plant-images/pending,
 *      discoveries/<requestId>) once they are empty.
 *
 * Stop the server while it runs: a photo being moved is briefly in two places.
 */

const fs = require('fs');
const path = require('path');
const { mysqlPool } = require('./pool-mysql');
const files = require('./image-files');
const relocation = require('./image-relocation');
const settings = require('./settings');

const DRY = process.argv.includes('--dry-run');

async function ensureColumns() {
    const wanted = [
        ['plant_images', 'fileIssue', 'VARCHAR(500) DEFAULT NULL'],
        ['plant_images', 'fileIssueAt', 'TIMESTAMP NULL DEFAULT NULL'],
        ['discovery_images', 'fileIssue', 'VARCHAR(500) DEFAULT NULL'],
        ['discovery_images', 'fileIssueAt', 'TIMESTAMP NULL DEFAULT NULL']
    ];
    for (const [table, column, definition] of wanted) {
        const [rows] = await mysqlPool.query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
            [table, column]
        );
        if (rows.length > 0) {
            console.log(`  ${table}.${column}: already there`);
            continue;
        }
        console.log(`  ${table}.${column}: ${DRY ? 'would add' : 'adding'}`);
        if (!DRY) await mysqlPool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
}

function atTarget(storedPath, targetDir) {
    return path.normalize(path.dirname(storedPath)) === path.normalize(targetDir);
}

async function migratePlantImages(totals) {
    const [rows] = await mysqlPool.query('SELECT imageId, plantId, status, storedPath FROM plant_images ORDER BY imageId');
    for (const row of rows) {
        const conn = await mysqlPool.getConnection();
        const plan = new files.FileMovePlan();
        try {
            await conn.beginTransaction();
            let requestId = null;
            let key;
            if (row.status === 'approved') {
                key = row.plantId;
                if (!key) { totals.skipped.push(`${row.imageId}: approved but has no plantId`); await conn.rollback(); continue; }
            } else {
                requestId = await relocation.findRequestIdForImage(conn, row.imageId);
                // A rejected photo whose request is gone is filed under its plant.
                key = requestId || (row.status === 'rejected' ? row.plantId : null);
                if (!key) { totals.skipped.push(`${row.imageId}: no request found for a ${row.status} photo`); await conn.rollback(); continue; }
                requestId = key;
            }
            const targetDir = files.plantRelativeDir(row.status, key);
            if (atTarget(row.storedPath, targetDir)) { totals.alreadyThere++; await conn.rollback(); continue; }
            if (DRY) { console.log(`  would move ${row.imageId}: ${row.storedPath} -> ${targetDir}/`); totals.moved++; await conn.rollback(); continue; }

            const outcome = await relocation.relocatePlantImages(conn, plan, {
                imageIds: [row.imageId], status: row.status, requestId, plantId: row.plantId
            });
            await conn.commit();
            await plan.finalize();
            relocation.tidyAfter(plan);
            totals.moved += outcome.moved;
            totals.failed.push(...outcome.failed.map((f) => `${f.imageId}: ${f.message}`));
        } catch (err) {
            await conn.rollback().catch(() => {});
            await plan.rollback();
            totals.failed.push(`${row.imageId}: ${err.message}`);
        } finally {
            conn.release();
        }
    }
}

async function migrateDiscoveryImages(totals) {
    const [rows] = await mysqlPool.query(
        `SELECT d.imageId, d.requestId, d.storedPath, ar.status
         FROM discovery_images d JOIN approval_requests ar ON ar.requestId = d.requestId
         ORDER BY d.imageId`
    );
    for (const row of rows) {
        if (!files.folderState(row.status)) {
            totals.skipped.push(`${row.imageId}: a ${row.status} report keeps no photos`);
            continue;
        }
        const targetDir = files.discoveryRelativeDir(row.status, row.requestId);
        if (atTarget(row.storedPath, targetDir)) { totals.alreadyThere++; continue; }
        if (DRY) { console.log(`  would move ${row.imageId}: ${row.storedPath} -> ${targetDir}/`); totals.moved++; continue; }

        const conn = await mysqlPool.getConnection();
        const plan = new files.FileMovePlan();
        try {
            await conn.beginTransaction();
            // The whole report at once: its photos always share one folder.
            const outcome = await relocation.relocateDiscoveryImages(conn, plan, row.requestId, row.status);
            await conn.commit();
            await plan.finalize();
            relocation.tidyAfter(plan);
            totals.moved += outcome.moved;
            totals.failed.push(...outcome.failed.map((f) => `${f.imageId}: ${f.message}`));
        } catch (err) {
            await conn.rollback().catch(() => {});
            await plan.rollback();
            totals.failed.push(`${row.imageId}: ${err.message}`);
        } finally {
            conn.release();
        }
    }
}

/** Legacy top-level folders (plant-images/<plantId>, plant-images/pending) once empty. */
function removeLegacyFolders() {
    const root = files.plantRoot();
    const keep = new Set([settings.plantImages.plantSubdir, settings.plantImages.discoverySubdir]);
    for (const entry of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
        if (!entry.isDirectory() || keep.has(entry.name)) continue;
        const dir = path.join(root, entry.name);
        const left = [];
        (function walk(d) {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                if (e.isDirectory()) walk(path.join(d, e.name)); else left.push(path.join(d, e.name));
            }
        })(dir);
        if (left.length === 0) {
            console.log(`  removing empty legacy folder ${entry.name}/`);
            if (!DRY) fs.rmSync(dir, { recursive: true, force: true });
        } else {
            console.log(`  keeping ${entry.name}/ (${left.length} file(s) still inside)`);
        }
    }
    // discoveries/<requestId> directly under the discovery root (the old layout).
    const dRoot = files.discoveryRoot();
    const states = new Set(Object.values(settings.plantImages.statusFolders));
    for (const entry of fs.existsSync(dRoot) ? fs.readdirSync(dRoot, { withFileTypes: true }) : []) {
        if (!entry.isDirectory() || states.has(entry.name)) continue;
        const dir = path.join(dRoot, entry.name);
        if (fs.readdirSync(dir).length === 0) {
            console.log(`  removing empty legacy folder discoveries/${entry.name}/`);
            if (!DRY) fs.rmdirSync(dir);
        }
    }
}

(async () => {
    const totals = { moved: 0, alreadyThere: 0, skipped: [], failed: [] };
    try {
        console.log(DRY ? 'DRY RUN: nothing will be changed.' : 'Migrating photo folders.');
        console.log('Columns:');
        await ensureColumns();
        if (!DRY) files.ensureImageTree();

        // After a dry run on a database that has not been migrated yet, the
        // fileIssue columns do not exist, and the relocation queries need them.
        if (DRY) {
            const [cols] = await mysqlPool.query(
                `SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = 'plant_images' AND column_name = 'fileIssue'`
            );
            if (cols.length === 0) console.log('  (a real run adds the columns first; the move list below is still accurate)');
        }

        console.log('Plant photos:');
        await migratePlantImages(totals);
        console.log('Discovery report photos:');
        await migrateDiscoveryImages(totals);
        console.log('Legacy folders:');
        removeLegacyFolders();

        console.log(`\nMoved: ${totals.moved}   Already in place: ${totals.alreadyThere}   ` +
            `Skipped: ${totals.skipped.length}   Failed: ${totals.failed.length}`);
        for (const line of totals.skipped) console.log('  skipped -', line);
        for (const line of totals.failed) console.log('  FAILED  -', line);
        if (totals.failed.length > 0) {
            console.log('\nFailed photos were left where they were and are flagged on the admin plants page. Run this script again to retry them.');
            process.exitCode = 1;
        }
    } catch (err) {
        console.error('Migration failed:', err.message);
        process.exitCode = 1;
    } finally {
        await mysqlPool.end();
    }
})();
