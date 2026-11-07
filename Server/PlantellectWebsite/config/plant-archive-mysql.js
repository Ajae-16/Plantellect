// Admin: archive and restore a whole plant (the Archive plant button, and the Archive / Restore
// buttons in the Inventory table).
//
// Archived = out of the library, the app and the public pages. plants.archivedAt / archivedBy /
// archiveReason hold it (NULL = active); plants.isArchive (1 / 0) is the query-friendly copy. Every public query already filters on
// p.archivedAt IS NULL, so the flag is what hides the plant. Masters, descriptions, votes and scan
// history are not touched: archiving is reversible and is NOT deletion, and it is a separate action
// from excluding photos from the training dataset.
//
// The public WebP copies are removed when a plant is archived (so a direct file URL stops working
// too) and rebuilt from the masters when it is restored.
//
// An archived plant can be DELETED on the Archive page (config/archive-delete-mysql.js): it keeps archivedAt,
// gets deletedAt, and is removed for good after the archive retention days. A plant in that Deleted status
// cannot be restored until the deletion is undone.

const { mysqlPool } = require('./pool-mysql');
const publicImages = require('./public-images');

const SAFE_ID = /^[A-Za-z0-9_-]{1,18}$/;
const ARCHIVE_REASON_MAX = 255;

const fail = (error, code) => ({ error, code });

function cleanReason(input) {
    if (input === undefined || input === null) return { reason: null };
    if (typeof input !== 'string') return fail('The archive reason must be text', 400);
    const reason = input.trim();
    if (reason.length > ARCHIVE_REASON_MAX) {
        return fail(`The archive reason can be at most ${ARCHIVE_REASON_MAX} characters`, 400);
    }
    return { reason: reason || null };
}

/**
 * Archives a plant. options: { accountId, reason }.
 * Returns { ok: true, plantId, archiveReason, copiesRemoved } or { error, code }.
 */
async function archivePlant(plantId, options = {}, deps = {}) {
    if (!SAFE_ID.test(String(plantId || ''))) return fail('That is not a valid plant id', 400);
    const checked = cleanReason(options.reason);
    if (checked.error) return checked;
    const db = deps.db || mysqlPool;
    const images = deps.images || publicImages;

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT archivedAt, deletedAt FROM plants WHERE plantId = ? FOR UPDATE', [plantId]);
        if (rows.length === 0) {
            await conn.rollback();
            return fail('Plant not found', 404);
        }
        if (rows[0].archivedAt) {
            await conn.rollback();
            return fail('This plant is already archived', 409);
        }
        await conn.query(
            'UPDATE plants SET archivedAt = NOW(), archivedBy = ?, archiveReason = ?, isArchive = 1 WHERE plantId = ?',
            [options.accountId || null, checked.reason, plantId]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }

    // After the commit: the plant is already hidden by the flag. Taking the files down is best effort
    // (never throws); the nightly reconcile removes anything left, because the plant is archived.
    let copiesRemoved = 0;
    try {
        const [imgs] = await db.query(
            `SELECT imageId FROM plant_images
             WHERE plantId = ? AND (thumbnailHash IS NOT NULL OR displayHash IS NOT NULL)`,
            [plantId]
        );
        const result = await images.removeCopiesForImages(imgs.map((r) => r.imageId), { executor: db });
        copiesRemoved = result.removed;
    } catch (err) {
        console.error(`Archive ${plantId}: public copies could not be removed: ${err.message}`);
    }
    return { ok: true, plantId, archiveReason: checked.reason, copiesRemoved };
}

/**
 * Brings an archived plant back. Photos that were public before come back public (their own
 * hidden / archived flags were never changed); their public copies are rebuilt from the masters.
 * Returns { ok: true, plantId, copiesMade } or { error, code }.
 */
async function restorePlant(plantId, deps = {}) {
    if (!SAFE_ID.test(String(plantId || ''))) return fail('That is not a valid plant id', 400);
    const db = deps.db || mysqlPool;
    const images = deps.images || publicImages;

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT archivedAt, deletedAt FROM plants WHERE plantId = ? FOR UPDATE', [plantId]);
        if (rows.length === 0) {
            await conn.rollback();
            return fail('Plant not found', 404);
        }
        if (!rows[0].archivedAt) {
            await conn.rollback();
            return fail('This plant is not archived', 409);
        }
        // Deleted status: waiting for its retention days. Undo the deletion (Archive page) first.
        if (rows[0].deletedAt) {
            await conn.rollback();
            return fail('This plant is waiting to be deleted. Undo the deletion first.', 409);
        }
        await conn.query(
            'UPDATE plants SET archivedAt = NULL, archivedBy = NULL, archiveReason = NULL, isArchive = 0 WHERE plantId = ?',
            [plantId]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }

    let copiesMade = 0;
    try {
        const [imgs] = await db.query(
            `SELECT imageId FROM plant_images
             WHERE plantId = ? AND status = 'approved' AND publicVisible = TRUE AND archivedAt IS NULL`,
            [plantId]
        );
        const result = await images.ensurePublicCopies(imgs.map((r) => r.imageId), { executor: db });
        copiesMade = result.made;
    } catch (err) {
        console.error(`Restore ${plantId}: public copies could not be rebuilt: ${err.message}`);
    }
    return { ok: true, plantId, copiesMade };
}

module.exports = { archivePlant, restorePlant, cleanReason, ARCHIVE_REASON_MAX };
