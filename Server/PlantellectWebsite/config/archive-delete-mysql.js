// The Deleted status of an archived plant, photo or description, and the nightly purge that finishes it.
//
//   active  ->  archived  ->  deleted  ->  (retention days pass)  ->  removed for good
//
// "Delete" never removes anything by itself. It sets deletedAt / deletedBy on an item that is already
// archived, so the item stays hidden and stays restorable ("Undo delete" clears the two columns and the
// item is archived again). The number of days it is kept is the admin setting in Settings > Archive &
// Deletion (config/archive-retention.js). Only purgeExpired() removes data, once deletedAt is older than that.
//
// What can be deleted, and what a piece's own state has to be:
//   plant        must be archived. Its photos and descriptions go with it when it is purged.
//   photo        must be archived, OR its plant must be archived. A photo of an archived plant can be deleted
//                piece by piece without being archived first (it is archived on the way, so it never shows).
//   description  the same rule as a photo.
//
// purgeExpired(), for each item whose deletedAt is older than the retention:
//   photo        public copies, then the master file, then the plant_images row
//   description  the plant_description row (its votes go with it) and its plant_parts row
//   plant        every photo's files, then the plants row (descriptions, parts, photos, contributor rows and
//                the plant's review requests go with it through ON DELETE CASCADE) and its own plant_types row
// Each item is handled in its own transaction with the row locked, so an "Undo delete" that arrives while the
// job runs either wins (nothing is removed) or waits (and finds the row gone). A file that cannot be removed
// leaves the row in place and the item is tried again the next night. Never throws.
//
// The database and the file functions are injected (`deps` / `options`) so the order of the steps can be
// tested without MySQL or sharp. Callers normally pass nothing.

const path = require('path');
const settings = require('./settings');
const archiveRetention = require('./archive-retention');
const { purgeAtOf, DAY_MS } = require('./archive-status');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const fail = (error, code = 400) => ({ error, code });

const defaultDb = () => require('./pool-mysql').mysqlPool;
const publicImages = () => require('./public-images');
const imageFiles = () => require('./image-files');

function checkIds(...ids) {
    for (const id of ids) {
        if (!SAFE_ID.test(String(id || ''))) return fail('That is not a valid id');
    }
    return null;
}

/** The answer of a successful delete: when it was deleted, when it will be removed, and the days it is kept. */
async function deleteAnswer(db, table, idColumn, id, extra) {
    const [rows] = await db.query(`SELECT deletedAt FROM ${table} WHERE ${idColumn} = ?`, [id]);
    const retentionDays = await archiveRetention.getRetentionDays(db);
    const deletedAt = rows[0] && rows[0].deletedAt ? rows[0].deletedAt : new Date();
    return { ok: true, ...extra, deletedAt, purgeAt: purgeAtOf(deletedAt, retentionDays), retentionDays };
}

// ---------------------------------------------------------------------------
// Delete / undo delete
// ---------------------------------------------------------------------------

/** Puts an ARCHIVED plant in the Deleted status. options: { accountId }. */
async function deletePlant(plantId, options = {}, deps = {}) {
    const bad = checkIds(plantId);
    if (bad) return bad;
    const db = deps.db || defaultDb();
    const accountId = (options && options.accountId) || null;

    const [rows] = await db.query('SELECT plantId, archivedAt, deletedAt FROM plants WHERE plantId = ?', [plantId]);
    if (rows.length === 0) return fail('Plant not found', 404);
    if (rows[0].deletedAt) return fail('This plant is already waiting to be deleted', 409);
    if (!rows[0].archivedAt) return fail('Archive the plant before deleting it', 409);

    const [done] = await db.query(
        `UPDATE plants SET deletedAt = NOW(), deletedBy = ?
         WHERE plantId = ? AND archivedAt IS NOT NULL AND deletedAt IS NULL`,
        [accountId, plantId]
    );
    if (!done.affectedRows) return fail('This plant changed while you were deleting it. Reload and try again.', 409);
    return deleteAnswer(db, 'plants', 'plantId', plantId, { plantId });
}

/** Cancels the deletion of a plant. It stays archived. */
async function undeletePlant(plantId, deps = {}) {
    const bad = checkIds(plantId);
    if (bad) return bad;
    const db = deps.db || defaultDb();
    const [rows] = await db.query('SELECT plantId, deletedAt FROM plants WHERE plantId = ?', [plantId]);
    if (rows.length === 0) return fail('Plant not found', 404);
    if (!rows[0].deletedAt) return fail('This plant is not waiting to be deleted', 409);
    await db.query('UPDATE plants SET deletedAt = NULL, deletedBy = NULL WHERE plantId = ? AND deletedAt IS NOT NULL', [plantId]);
    return { ok: true, plantId };
}

/**
 * Puts a photo in the Deleted status. The photo must be archived, or its plant must be archived (then
 * the photo is archived first, so it can never show). options: { accountId, reason }.
 * deps.photos lets a test replace config/photo-visibility.js.
 */
async function deletePhoto(plantId, imageId, options = {}, deps = {}) {
    const bad = checkIds(plantId, imageId);
    if (bad) return bad;
    const db = deps.db || defaultDb();
    const photos = deps.photos || require('./photo-visibility');
    const accountId = (options && options.accountId) || null;

    const [rows] = await db.query(
        `SELECT i.imageId, i.status, i.archivedAt, i.deletedAt, p.archivedAt AS plantArchivedAt
         FROM plant_images i JOIN plants p ON p.plantId = i.plantId
         WHERE i.imageId = ? AND i.plantId = ?`,
        [imageId, plantId]
    );
    if (rows.length === 0) return fail('Photo not found on this plant', 404);
    const photo = rows[0];
    if (photo.status !== 'approved') return fail('Only an approved photo can be deleted from here', 409);
    if (photo.deletedAt) return fail('This photo is already waiting to be deleted', 409);
    if (!photo.archivedAt && !photo.plantArchivedAt) {
        return fail('Archive the photo (or its plant) before deleting it', 409);
    }

    if (!photo.archivedAt) {
        const archived = await photos.archivePhoto(plantId, imageId, {
            accountId, reason: (options && options.reason) || 'Deleted with its archived plant'
        });
        if (archived && archived.error) return archived;
    }

    const [done] = await db.query(
        `UPDATE plant_images SET deletedAt = NOW(), deletedBy = ?
         WHERE imageId = ? AND plantId = ? AND archivedAt IS NOT NULL AND deletedAt IS NULL`,
        [accountId, imageId, plantId]
    );
    if (!done.affectedRows) return fail('This photo changed while you were deleting it. Reload and try again.', 409);
    return deleteAnswer(db, 'plant_images', 'imageId', imageId, { plantId, imageId });
}

/** Cancels the deletion of a photo. It stays archived (and hidden). */
async function undeletePhoto(plantId, imageId, deps = {}) {
    const bad = checkIds(plantId, imageId);
    if (bad) return bad;
    const db = deps.db || defaultDb();
    const [rows] = await db.query('SELECT imageId, deletedAt FROM plant_images WHERE imageId = ? AND plantId = ?', [imageId, plantId]);
    if (rows.length === 0) return fail('Photo not found on this plant', 404);
    if (!rows[0].deletedAt) return fail('This photo is not waiting to be deleted', 409);
    await db.query('UPDATE plant_images SET deletedAt = NULL, deletedBy = NULL WHERE imageId = ? AND deletedAt IS NOT NULL', [imageId]);
    return { ok: true, plantId, imageId };
}

/**
 * Puts a description in the Deleted status. Same rule as a photo: the description is archived, or its
 * plant is (then it is archived first). options: { accountId, reason }.
 * deps.descriptions lets a test replace config/description-archive-mysql.js.
 */
async function deleteDescription(plantId, descriptionId, options = {}, deps = {}) {
    const bad = checkIds(plantId, descriptionId);
    if (bad) return bad;
    const db = deps.db || defaultDb();
    const descriptions = deps.descriptions || require('./description-archive-mysql');
    const accountId = (options && options.accountId) || null;

    const [rows] = await db.query(
        `SELECT d.descriptionId, d.status, d.archivedAt, d.deletedAt, p.archivedAt AS plantArchivedAt
         FROM plant_description d JOIN plants p ON p.plantId = d.plantId
         WHERE d.descriptionId = ? AND d.plantId = ?`,
        [descriptionId, plantId]
    );
    if (rows.length === 0) return fail('Description not found on this plant', 404);
    const d = rows[0];
    if (d.status !== 'approved') return fail('Only an approved description can be deleted from here', 409);
    if (d.deletedAt) return fail('This description is already waiting to be deleted', 409);
    if (!d.archivedAt && !d.plantArchivedAt) {
        return fail('Archive the description (or its plant) before deleting it', 409);
    }

    if (!d.archivedAt) {
        const archived = await descriptions.archiveDescription(plantId, descriptionId, {
            accountId, reason: (options && options.reason) || 'Deleted with its archived plant'
        });
        if (archived && archived.error) return archived;
    }

    const [done] = await db.query(
        `UPDATE plant_description SET deletedAt = NOW(), deletedBy = ?
         WHERE descriptionId = ? AND plantId = ? AND archivedAt IS NOT NULL AND deletedAt IS NULL`,
        [accountId, descriptionId, plantId]
    );
    if (!done.affectedRows) return fail('This description changed while you were deleting it. Reload and try again.', 409);
    return deleteAnswer(db, 'plant_description', 'descriptionId', descriptionId, { plantId, descriptionId });
}

/** Cancels the deletion of a description. It stays archived. */
async function undeleteDescription(plantId, descriptionId, deps = {}) {
    const bad = checkIds(plantId, descriptionId);
    if (bad) return bad;
    const db = deps.db || defaultDb();
    const [rows] = await db.query(
        'SELECT descriptionId, deletedAt FROM plant_description WHERE descriptionId = ? AND plantId = ?',
        [descriptionId, plantId]
    );
    if (rows.length === 0) return fail('Description not found on this plant', 404);
    if (!rows[0].deletedAt) return fail('This description is not waiting to be deleted', 409);
    await db.query(
        'UPDATE plant_description SET deletedAt = NULL, deletedBy = NULL WHERE descriptionId = ? AND deletedAt IS NOT NULL',
        [descriptionId]
    );
    return { ok: true, plantId, descriptionId };
}

// ---------------------------------------------------------------------------
// The purge
// ---------------------------------------------------------------------------

/** One item's transaction on its own connection: commit on success, roll back and rethrow on any error. */
async function inItsOwnTransaction(db, fn) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

function fileTools(options) {
    return {
        masterFileOf: options.masterFileOf || ((p) => publicImages().masterFileOf(p)),
        removeCopies: options.removeCopies || ((plantId, imageId) => publicImages().removePublicCopies(plantId, imageId)),
        removeFile: options.removeFile || ((file) => require('fs').promises.unlink(file)),
        pruneDirs: options.pruneDirs || ((file) => {
            const masters = path.join(imageFiles().plantRoot(), settings.plantImages.plantSubdir);
            imageFiles().pruneEmptyDirs(path.dirname(file), masters);
        })
    };
}

/** Removes the public copies and the master of one photo. A master that is already gone is fine. */
async function removePhotoFiles(tools, row) {
    const file = tools.masterFileOf(row.storedPath);
    // A path that leaves the image folder is never deleted.
    if (!file) throw new Error(`${row.imageId} has a path outside the image folder; left alone`);
    if (row.plantId) await tools.removeCopies(row.plantId, row.imageId);
    try {
        await tools.removeFile(file);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    return file;
}

async function purgePhotos(db, cutoff, batch, tools, result) {
    const [rows] = await db.query(
        'SELECT imageId FROM plant_images WHERE deletedAt IS NOT NULL AND deletedAt < ? ORDER BY deletedAt ASC LIMIT ?',
        [cutoff, batch]
    );
    for (const { imageId } of rows) {
        result.checked++;
        try {
            const file = await inItsOwnTransaction(db, async (conn) => {
                const [locked] = await conn.query(
                    `SELECT imageId, plantId, storedPath FROM plant_images
                     WHERE imageId = ? AND deletedAt IS NOT NULL AND deletedAt < ? FOR UPDATE`,
                    [imageId, cutoff]
                );
                if (locked.length === 0) return null;   // un-deleted meanwhile
                const removed = await removePhotoFiles(tools, locked[0]);
                await conn.query('DELETE FROM plant_images WHERE imageId = ?', [imageId]);
                return removed;
            });
            if (file) {
                tools.pruneDirs(file);
                result.photos++;
            }
        } catch (err) {
            result.failed++;
            console.error(`Archive purge: could not remove photo ${imageId}: ${err.message}`);
        }
    }
}

async function purgeDescriptions(db, cutoff, batch, result) {
    const [rows] = await db.query(
        'SELECT descriptionId FROM plant_description WHERE deletedAt IS NOT NULL AND deletedAt < ? ORDER BY deletedAt ASC LIMIT ?',
        [cutoff, batch]
    );
    for (const { descriptionId } of rows) {
        result.checked++;
        try {
            const done = await inItsOwnTransaction(db, async (conn) => {
                const [locked] = await conn.query(
                    `SELECT descriptionId, plantId, partsId, isPrimary FROM plant_description
                     WHERE descriptionId = ? AND deletedAt IS NOT NULL AND deletedAt < ? FOR UPDATE`,
                    [descriptionId, cutoff]
                );
                if (locked.length === 0) return false;   // un-deleted meanwhile
                const d = locked[0];
                // The plant must not lose its primary description to a purge: the best remaining one takes it.
                if (d.isPrimary) {
                    await require('./description-archive-mysql').handOverPrimary(conn, d.plantId, d.descriptionId);
                }
                await conn.query('DELETE FROM plant_description WHERE descriptionId = ?', [descriptionId]);
                if (d.partsId) {
                    await conn.query(
                        `DELETE FROM plant_parts WHERE partId = ?
                         AND NOT EXISTS (SELECT 1 FROM plant_description x WHERE x.partsId = ?)`,
                        [d.partsId, d.partsId]
                    );
                }
                return true;
            });
            if (done) result.descriptions++;
        } catch (err) {
            result.failed++;
            console.error(`Archive purge: could not remove description ${descriptionId}: ${err.message}`);
        }
    }
}

async function purgePlants(db, cutoff, batch, tools, result) {
    const [rows] = await db.query(
        `SELECT plantId FROM plants
         WHERE deletedAt IS NOT NULL AND archivedAt IS NOT NULL AND deletedAt < ? ORDER BY deletedAt ASC LIMIT ?`,
        [cutoff, batch]
    );
    for (const { plantId } of rows) {
        result.checked++;
        try {
            const files = await inItsOwnTransaction(db, async (conn) => {
                const [locked] = await conn.query(
                    `SELECT plantId, typeId FROM plants
                     WHERE plantId = ? AND deletedAt IS NOT NULL AND archivedAt IS NOT NULL AND deletedAt < ? FOR UPDATE`,
                    [plantId, cutoff]
                );
                if (locked.length === 0) return null;   // un-deleted meanwhile
                const [images] = await conn.query('SELECT imageId, plantId, storedPath FROM plant_images WHERE plantId = ?', [plantId]);
                const removed = [];
                for (const img of images) removed.push(await removePhotoFiles(tools, img));
                // Descriptions, parts, photos and contributor rows go with the plant (ON DELETE CASCADE).
                await conn.query('DELETE FROM plants WHERE plantId = ?', [plantId]);
                // A plant owns its type row; delete it when nothing else uses it.
                try {
                    await conn.query(
                        'DELETE FROM plant_types WHERE typeId = ? AND NOT EXISTS (SELECT 1 FROM plants x WHERE x.typeId = ?)',
                        [locked[0].typeId, locked[0].typeId]
                    );
                } catch (err) {
                    console.error(`Archive purge: type of ${plantId} left in place: ${err.message}`);
                }
                return removed;
            });
            if (files) {
                for (const file of files) tools.pruneDirs(file);
                result.plants++;
            }
        } catch (err) {
            result.failed++;
            console.error(`Archive purge: could not remove plant ${plantId}: ${err.message}`);
        }
    }
}

/**
 * Removes everything whose deletedAt is older than the retention. Options (for tests): executor, now, days,
 * batch, masterFileOf, removeCopies, removeFile, pruneDirs.
 * Returns { checked, photos, descriptions, plants, failed }. Never throws.
 */
async function purgeExpired(options = {}) {
    const result = { checked: 0, photos: 0, descriptions: 0, plants: 0, failed: 0 };
    try {
        const db = options.executor || defaultDb();
        const now = options.now !== undefined ? new Date(options.now) : new Date();
        const days = Math.max(1, options.days !== undefined ? options.days : await archiveRetention.getRetentionDays(db));
        const batch = options.batch !== undefined ? options.batch : settings.archive.purgeBatchSize;
        const cutoff = new Date(now.getTime() - days * DAY_MS);
        const tools = fileTools(options);

        // Pieces first, the plant last: a plant that is purged in the same run takes what is left with it.
        await purgePhotos(db, cutoff, batch, tools, result);
        await purgeDescriptions(db, cutoff, batch, result);
        await purgePlants(db, cutoff, batch, tools, result);
    } catch (err) {
        result.failed++;
        console.error('Archive purge failed:', err.message);
    }
    return result;
}

function describe(result) {
    if (!result || (result.checked === 0 && result.failed === 0)) return null;
    return `Archive purge: ${result.plants} plant(s), ${result.photos} photo(s), ${result.descriptions} description(s) removed, ` +
        `${result.failed} failed, ${result.checked} checked`;
}

module.exports = {
    deletePlant, undeletePlant, deletePhoto, undeletePhoto, deleteDescription, undeleteDescription,
    purgeExpired, describe
};
