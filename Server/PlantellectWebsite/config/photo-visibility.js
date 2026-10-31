// Admin control of which approved photos the public can see (dataset handler plan,
// stage 7a).
//
// Three actions on one approved photo of a plant:
//
//   hide     delete the public copies FIRST, then set publicVisible = FALSE. If a
//            delete fails (a locked file on Windows, a permissions problem) nothing
//            changes in the database, the photo stays visible, and the admin gets an
//            error. The database therefore never says "hidden" while the file is
//            still being served.
//   restore  generate the public copies from the master FIRST, then set
//            publicVisible = TRUE and store the copy hashes in the same UPDATE. If the
//            copies cannot be made, the flag stays FALSE. The database therefore
//            never says "visible" without a file to show.
//   primary  make one visible photo the plant's primary (hero) photo.
//
// Hiding is not archiving and is not denial: the photo stays approved, stays in the
// master store and stays eligible for training. Only its public copies go away.
//
// The database and the file builders are injected (`deps`) so the order of the steps
// can be tested without MySQL or sharp. Callers normally pass nothing.

const publicImages = require('./public-images');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const fail = (error, code = 400, extra = {}) => ({ error, code, ...extra });

function resolveDeps(deps = {}) {
    return {
        db: deps.db || require('./pool-mysql').mysqlPool,
        build: deps.build || publicImages.buildPublicCopies,
        remove: deps.remove || publicImages.removePublicCopies
    };
}

function checkIds(plantId, imageId) {
    if (!SAFE_ID.test(String(plantId || '')) || (imageId !== undefined && !SAFE_ID.test(String(imageId || '')))) {
        return fail('That is not a valid plant or photo id', 400);
    }
    return null;
}

/** Runs fn(conn) in a transaction on a connection from the pool, committing on success. */
async function inTransaction(db, fn) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        if (result && result.error) {
            await conn.rollback();
        } else {
            await conn.commit();
        }
        return result;
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Every approved photo of a plant, primary first, with what the admin needs to
 * decide: who sent it, whether the public can see it, and whether its public copies
 * are really in place. The picture itself is shown through the admin review route
 * (/admin/api/plant-images/:imageId), which reads the master, so a hidden photo is
 * still visible to the admin.
 */
async function listPlantPhotos(plantId, deps) {
    const bad = checkIds(plantId);
    if (bad) return bad;
    const { db } = resolveDeps(deps);
    const [plants] = await db.query('SELECT plantId, archivedAt FROM plants WHERE plantId = ?', [plantId]);
    if (plants.length === 0) return fail('Plant not found', 404);

    const [rows] = await db.query(
        `SELECT i.imageId, i.status, i.isPrimary, i.publicVisible, i.archivedAt, i.uploadedAt,
                i.thumbnailHash, i.displayHash, a.username AS uploadedByName
         FROM plant_images i
         JOIN accounts a ON a.accountId = i.accountId
         WHERE i.plantId = ? AND i.status = 'approved'
         ORDER BY i.isPrimary DESC, i.uploadedAt ASC`,
        [plantId]
    );
    return {
        plantId,
        plantArchived: Boolean(plants[0].archivedAt),
        photos: rows.map((r) => ({
            imageId: r.imageId,
            status: r.status,
            isPrimary: Boolean(r.isPrimary),
            publicVisible: Boolean(r.publicVisible),
            archived: Boolean(r.archivedAt),
            // Visible to the public right now: the same rule the public queries use.
            publicNow: Boolean(r.publicVisible) && !r.archivedAt && Boolean(r.thumbnailHash) && Boolean(r.displayHash)
                && !plants[0].archivedAt,
            uploadedAt: r.uploadedAt,
            uploadedByName: r.uploadedByName,
            previewUrl: `/admin/api/plant-images/${encodeURIComponent(r.imageId)}`
        }))
    };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

async function loadPhoto(conn, plantId, imageId) {
    const [rows] = await conn.query(
        `SELECT imageId, plantId, status, isPrimary, publicVisible, archivedAt, storedPath
         FROM plant_images WHERE imageId = ? AND plantId = ? FOR UPDATE`,
        [imageId, plantId]
    );
    return rows[0] || null;
}

/**
 * After a photo stops being public, the plant still needs a primary photo that the
 * public can see. Hands the flag to the oldest visible photo, or leaves the plant
 * with none when nothing is visible.
 */
async function reassignPrimary(conn, plantId) {
    const [current] = await conn.query(
        `SELECT imageId FROM plant_images
         WHERE plantId = ? AND status = 'approved' AND isPrimary = TRUE
           AND publicVisible = TRUE AND archivedAt IS NULL LIMIT 1`,
        [plantId]
    );
    if (current.length > 0) return;
    await conn.query('UPDATE plant_images SET isPrimary = FALSE WHERE plantId = ? AND isPrimary = TRUE', [plantId]);
    await conn.query(
        `UPDATE plant_images SET isPrimary = TRUE
         WHERE imageId = (
             SELECT pick.imageId FROM (
                 SELECT imageId FROM plant_images
                 WHERE plantId = ? AND status = 'approved' AND publicVisible = TRUE AND archivedAt IS NULL
                   AND thumbnailHash IS NOT NULL AND displayHash IS NOT NULL
                 ORDER BY uploadedAt ASC LIMIT 1
             ) pick
         )`,
        [plantId]
    );
}

/**
 * Hides one approved photo from the public. Order: delete the files, then set the flag.
 * Returns { ok: true, ... } or { error, code }.
 */
async function hidePhoto(plantId, imageId, deps) {
    const bad = checkIds(plantId, imageId);
    if (bad) return bad;
    const { db, remove } = resolveDeps(deps);

    const photo = await inTransaction(db, async (conn) => loadPhoto(conn, plantId, imageId));
    if (!photo) return fail('Photo not found on this plant', 404);
    if (photo.status !== 'approved') return fail('Only an approved photo can be hidden', 409);

    // 1. Files first. A failure here leaves the database untouched.
    try {
        await remove(plantId, imageId);
    } catch (err) {
        console.error(`Hide ${imageId}: public copies could not be deleted: ${err.message}`);
        return fail(
            `The public file could not be deleted (${err.code || err.message}), so the photo is still visible. ` +
            'Close anything that has the file open and try again.',
            500, { reason: 'delete_failed' }
        );
    }

    // 2. Then the flag, and a new primary if this one was it.
    const result = await inTransaction(db, async (conn) => {
        const again = await loadPhoto(conn, plantId, imageId);
        if (!again) return fail('Photo not found on this plant', 404);
        await conn.query(
            `UPDATE plant_images
             SET publicVisible = FALSE, thumbnailHash = NULL, displayHash = NULL, isPrimary = FALSE
             WHERE imageId = ?`,
            [imageId]
        );
        await reassignPrimary(conn, plantId);
        return { ok: true, plantId, imageId, wasPrimary: Boolean(photo.isPrimary) };
    });
    if (result.error) return result;

    // 3. A regeneration that ran between steps 1 and 2 (the startup catch-up) would
    //    have written the files back; delete once more so the end state is certain.
    try {
        await remove(plantId, imageId);
    } catch (err) {
        console.error(`Hide ${imageId}: second delete failed: ${err.message}`);
        return fail(
            'The photo is hidden, but a public file could not be removed. Try Hide again.',
            500, { reason: 'delete_failed_after_flag' }
        );
    }
    return result;
}

/**
 * Makes a hidden photo public again. Order: build the copies from the master, then set
 * the flag and the hashes in one UPDATE.
 */
async function restorePhoto(plantId, imageId, deps) {
    const bad = checkIds(plantId, imageId);
    if (bad) return bad;
    const { db, build, remove } = resolveDeps(deps);

    const photo = await inTransaction(db, async (conn) => {
        const row = await loadPhoto(conn, plantId, imageId);
        if (!row) return null;
        const [plants] = await conn.query('SELECT archivedAt FROM plants WHERE plantId = ?', [plantId]);
        return { ...row, plantArchived: Boolean(plants[0] && plants[0].archivedAt) };
    });
    if (!photo) return fail('Photo not found on this plant', 404);
    if (photo.status !== 'approved') return fail('Only an approved photo can be shown', 409);
    if (photo.archivedAt) return fail('This photo is archived. Unarchive it first.', 409);
    if (photo.plantArchived) return fail('This plant is archived, so its photos cannot be shown. Restore the plant first.', 409);

    // 1. Copies first. A failure leaves the flag FALSE.
    const built = await build({ imageId, plantId, storedPath: photo.storedPath });
    if (!built || !built.ok) {
        return fail(`The public copies could not be made: ${built && built.error ? built.error : 'unknown error'}. The photo stays hidden.`, 500, { reason: 'build_failed' });
    }

    // 2. Then the flag, the hashes and (if the plant has none) the primary flag.
    try {
        return await inTransaction(db, async (conn) => {
            const again = await loadPhoto(conn, plantId, imageId);
            if (!again) return fail('Photo not found on this plant', 404);
            await conn.query(
                `UPDATE plant_images SET publicVisible = TRUE, thumbnailHash = ?, displayHash = ? WHERE imageId = ?`,
                [built.thumbnailHash, built.displayHash, imageId]
            );
            const [primary] = await conn.query(
                `SELECT imageId FROM plant_images
                 WHERE plantId = ? AND status = 'approved' AND isPrimary = TRUE
                   AND publicVisible = TRUE AND archivedAt IS NULL AND imageId <> ? LIMIT 1`,
                [plantId, imageId]
            );
            let becamePrimary = false;
            if (primary.length === 0) {
                await conn.query('UPDATE plant_images SET isPrimary = FALSE WHERE plantId = ? AND isPrimary = TRUE', [plantId]);
                await conn.query('UPDATE plant_images SET isPrimary = TRUE WHERE imageId = ?', [imageId]);
                becamePrimary = true;
            }
            return { ok: true, plantId, imageId, becamePrimary };
        });
    } catch (err) {
        // The database refused after the files were written: take them back down so a
        // file is never served for a photo the database calls hidden.
        await remove(plantId, imageId).catch(() => {});
        throw err;
    }
}

/** Makes one visible, approved photo the plant's primary photo. */
async function setPrimaryPhoto(plantId, imageId, deps) {
    const bad = checkIds(plantId, imageId);
    if (bad) return bad;
    const { db } = resolveDeps(deps);
    return inTransaction(db, async (conn) => {
        const photo = await loadPhoto(conn, plantId, imageId);
        if (!photo) return fail('Photo not found on this plant', 404);
        if (photo.status !== 'approved') return fail('Only an approved photo can be the primary photo', 409);
        if (photo.archivedAt) return fail('An archived photo cannot be the primary photo', 409);
        if (!photo.publicVisible) return fail('A hidden photo cannot be the primary photo. Show it first.', 409);
        await conn.query('UPDATE plant_images SET isPrimary = FALSE WHERE plantId = ? AND isPrimary = TRUE', [plantId]);
        await conn.query('UPDATE plant_images SET isPrimary = TRUE WHERE imageId = ?', [imageId]);
        return { ok: true, plantId, imageId };
    });
}

module.exports = { listPlantPhotos, hidePhoto, restorePhoto, setPrimaryPhoto, reassignPrimary };
