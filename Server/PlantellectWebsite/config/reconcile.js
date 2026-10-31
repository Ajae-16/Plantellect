// Reconcile job for the public photo copies (dataset handler plan, stage 7b).
//
// public/resource/plant-images holds derived data: a thumbnail and a display copy of every
// approved, visible photo, each made FROM a master. This job keeps that folder honest. It
// runs at startup and every night, and does three things:
//
//   1. ORPHANS   a file with no visible record is deleted (a hidden, archived, denied or
//                deleted photo, a leftover temporary file, anything dropped in by hand).
//   2. MISSING   a visible photo whose copy is gone, or whose hash was never stored, gets
//                its copies regenerated from the master.
//   3. TAMPERED  a copy whose SHA-256 no longer matches the hash stored on the row is
//                regenerated from the master, so a hand-edited file heals itself.
//
// "Visible record" is one rule, the same as the public queries: the photo is approved,
// publicVisible, not archived, and so is its plant. A photo does NOT need hashes to count:
// an approval writes the files first and the hashes a moment later.
//
// Safety, because this job deletes files:
//
//   - It only looks inside thumbnail/ and display/. Anything else in the folder is left
//     alone (the static handler never serves it anyway).
//   - It never follows a link: every entry is read with lstat, and a link is removed as a
//     link, never entered.
//   - A file newer than orphanGraceSeconds is never deleted as an orphan, so a copy that a
//     restore has just written, but whose flag is not set yet, survives this run.
//   - After it writes a regenerated copy it checks the record again. If the photo was
//     hidden in the meantime, the copy is deleted again. Together with the second delete in
//     hidePhoto() this closes the window in which a hide and a repair could cross.
//   - A copy that cannot be verified or rebuilt (the master is gone) is removed rather than
//     served unchecked, and its hashes are cleared so the photo is not listed.
//   - Only one run at a time. It never throws: a failure is logged and counted.
//
// The database and the disk helpers are injectable, so the tests need neither MySQL nor a
// real photo library.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');
const publicImages = require('./public-images');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COPY_NAME = /^([A-Za-z0-9_-]{1,64})\.webp$/;

const defaultExecutor = () => require('./pool-mysql').mysqlPool;

// ---------------------------------------------------------------------------
// What the database says should exist
// ---------------------------------------------------------------------------

/** Every photo that must have public copies right now. */
async function loadVisibleRecords(db) {
    const [rows] = await db.query(
        `SELECT i.imageId, i.plantId, i.storedPath, i.thumbnailHash, i.displayHash
         FROM plant_images i
         JOIN plants p ON p.plantId = i.plantId
         WHERE i.status = 'approved' AND i.publicVisible = TRUE AND i.archivedAt IS NULL
           AND p.archivedAt IS NULL AND i.plantId IS NOT NULL`
    );
    return rows;
}

/** True when this one photo is still allowed to be public (the same rule, for one row). */
async function stillVisible(db, imageId) {
    const [rows] = await db.query(
        `SELECT i.imageId
         FROM plant_images i
         JOIN plants p ON p.plantId = i.plantId
         WHERE i.imageId = ? AND i.status = 'approved' AND i.publicVisible = TRUE
           AND i.archivedAt IS NULL AND p.archivedAt IS NULL AND i.plantId IS NOT NULL`,
        [imageId]
    );
    return rows.length > 0;
}

const keyOf = (size, plantId, imageId) => `${size}/${plantId}/${imageId}`;

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

const root = () => path.resolve(settings.plantImages.publicDir);

async function sha256File(file) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
    });
    return hash.digest('hex');
}

/** Removes a file, a link or a folder inside the public tree. Never follows a link. */
async function removeEntry(target, isDirectory) {
    if (!path.resolve(target).startsWith(root() + path.sep)) throw new Error('refusing to delete outside the public folder');
    if (isDirectory) await fsp.rm(target, { recursive: true, force: true });
    else await fsp.unlink(target);
}

/**
 * Lists what is on disk under thumbnail/ and display/.
 *   copies:   well-formed copies   { size, plantId, imageId, file, mtimeMs }
 *   strays:   everything else      { target, isDirectory, mtimeMs }  (to be removed)
 *   plantDirs: the <plantId> folders, so empty ones can be tidied
 */
async function scanPublicTree() {
    const copies = [];
    const strays = [];
    const plantDirs = [];
    for (const size of publicImages.SIZES) {
        const sizeDir = path.join(root(), size);
        let entries;
        try {
            entries = await fsp.readdir(sizeDir);
        } catch (err) {
            if (err.code === 'ENOENT') continue;
            throw err;
        }
        for (const name of entries) {
            const entry = path.join(sizeDir, name);
            const stat = await fsp.lstat(entry);
            if (!stat.isDirectory() || !SAFE_ID.test(name)) {
                strays.push({ target: entry, isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs });
                continue;
            }
            plantDirs.push(entry);
            for (const child of await fsp.readdir(entry)) {
                const file = path.join(entry, child);
                const childStat = await fsp.lstat(file);
                const match = COPY_NAME.exec(child);
                if (childStat.isFile() && match) {
                    copies.push({ size, plantId: name, imageId: match[1], file, mtimeMs: childStat.mtimeMs });
                } else {
                    strays.push({ target: file, isDirectory: childStat.isDirectory(), mtimeMs: childStat.mtimeMs });
                }
            }
        }
    }
    return { copies, strays, plantDirs };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

let running = false;

function emptySummary() {
    return {
        checked: 0,
        orphansRemoved: 0,
        orphansKept: 0,
        missingRepaired: 0,
        tamperedRepaired: 0,
        unverifiedRepaired: 0,
        removedUnrepairable: 0,
        failed: 0,
        skipped: false
    };
}

/**
 * Runs one reconcile pass. Options (all for tests): executor, now, graceSeconds, build,
 * remove, hashFile.
 * Returns the counts. Never throws.
 */
async function reconcilePublicCopies(options = {}) {
    const summary = emptySummary();
    if (running) {
        summary.skipped = true;
        return summary;
    }
    running = true;
    try {
        const db = options.executor || defaultExecutor();
        const now = options.now !== undefined ? options.now : Date.now();
        const graceMs = (options.graceSeconds !== undefined ? options.graceSeconds : settings.plantImages.orphanGraceSeconds) * 1000;
        const build = options.build || publicImages.buildPublicCopies;
        const remove = options.remove || publicImages.removePublicCopies;
        const hashFile = options.hashFile || sha256File;

        const records = await loadVisibleRecords(db);
        const wanted = new Map();
        for (const row of records) {
            for (const size of publicImages.SIZES) wanted.set(keyOf(size, row.plantId, row.imageId), row);
        }

        const tree = await scanPublicTree();

        // 1. Orphans: no visible record, or not a well-formed copy at all.
        const orphan = (entry) => ({ target: entry.file || entry.target, isDirectory: Boolean(entry.isDirectory), mtimeMs: entry.mtimeMs });
        const orphans = [
            ...tree.strays.map(orphan),
            ...tree.copies.filter((c) => !wanted.has(keyOf(c.size, c.plantId, c.imageId))).map(orphan)
        ];
        for (const entry of orphans) {
            if (now - entry.mtimeMs < graceMs) {
                summary.orphansKept++;
                continue;
            }
            try {
                await removeEntry(entry.target, entry.isDirectory);
                summary.orphansRemoved++;
            } catch (err) {
                if (err.code === 'ENOENT') continue;
                summary.failed++;
                console.error(`Reconcile: could not remove ${entry.target}: ${err.message}`);
            }
        }
        for (const dir of tree.plantDirs) await fsp.rmdir(dir).catch(() => {});

        // 2 and 3. Missing and tampered copies of photos that must be public.
        const onDisk = new Set(tree.copies.map((c) => keyOf(c.size, c.plantId, c.imageId)));
        for (const row of records) {
            summary.checked++;
            const problem = await findProblem(row, onDisk, hashFile);
            if (!problem) continue;
            await repair(db, row, problem, { build, remove, summary });
        }
    } catch (err) {
        summary.failed++;
        console.error('Reconcile failed:', err.message);
    } finally {
        running = false;
    }
    return summary;
}

/** Returns null when both copies exist and match their stored hash, else 'missing', 'unverified' or 'tampered'. */
async function findProblem(row, onDisk, hashFile) {
    let problem = null;
    for (const size of publicImages.SIZES) {
        const stored = row[`${size}Hash`];
        if (!onDisk.has(keyOf(size, row.plantId, row.imageId))) return 'missing';
        if (!stored) {
            problem = problem || 'unverified';
            continue;
        }
        let actual;
        try {
            actual = await hashFile(publicImages.publicFilePath(size, row.plantId, row.imageId));
        } catch (err) {
            return 'missing';
        }
        if (actual !== stored) return 'tampered';
    }
    return problem;
}

async function repair(db, row, problem, { build, remove, summary }) {
    try {
        const built = await build(row);
        if (!built.ok) {
            // Nothing to heal it from (the master is gone or unreadable). A copy we cannot
            // verify must not stay public, and a photo with a hash but no file would be
            // listed with a broken image, so both copies go and the hashes are cleared.
            await remove(row.plantId, row.imageId);
            await db.query('UPDATE plant_images SET thumbnailHash = NULL, displayHash = NULL WHERE imageId = ?', [row.imageId]);
            summary.removedUnrepairable++;
            console.error(`Reconcile: ${row.imageId} could not be verified or rebuilt (${built.error}); its public copies were removed`);
            return;
        }
        // The files are written. If the photo was hidden or denied while we worked, take
        // them straight down again instead of recording hashes for them.
        if (!(await stillVisible(db, row.imageId))) {
            await remove(row.plantId, row.imageId);
            return;
        }
        await db.query(
            'UPDATE plant_images SET thumbnailHash = ?, displayHash = ? WHERE imageId = ?',
            [built.thumbnailHash, built.displayHash, row.imageId]
        );
        if (problem === 'missing') summary.missingRepaired++;
        else if (problem === 'tampered') summary.tamperedRepaired++;
        else summary.unverifiedRepaired++;
    } catch (err) {
        summary.failed++;
        console.error(`Reconcile: could not repair ${row.imageId}: ${err.message}`);
    }
}

/** One line for the log, or null when nothing happened. */
function describe(summary) {
    if (summary.skipped) return 'Public copy reconcile skipped: a run is already in progress';
    const changed = summary.orphansRemoved + summary.missingRepaired + summary.tamperedRepaired
        + summary.unverifiedRepaired + summary.removedUnrepairable + summary.failed;
    if (changed === 0) return null;
    return `Public copy reconcile: ${summary.checked} checked, ${summary.orphansRemoved} orphan(s) removed, `
        + `${summary.missingRepaired} missing, ${summary.tamperedRepaired} tampered and ${summary.unverifiedRepaired} unverified repaired, `
        + `${summary.removedUnrepairable} removed (no master), ${summary.failed} failed`;
}

module.exports = {
    reconcilePublicCopies,
    describe,
    scanPublicTree,
    loadVisibleRecords,
    stillVisible
};
