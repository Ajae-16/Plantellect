// Admin control of which approved photos the public can see (dataset handler)
//
// Five actions on one approved photo of a plant:
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
//   archive  take the photo out of use: delete the public copies FIRST (same order rule as
//            hide), then set archivedAt / archivedBy / archiveReason and publicVisible = FALSE
//            in one UPDATE, and hand the primary flag on if this photo held it. An archived
//            photo is invisible to the public and does not count as a training candidate.
//   unarchive  clear the three archive columns. The photo comes back HIDDEN, never public:
//            archive set publicVisible = FALSE and unarchive does not guess what it was
//            before, so an admin has to press Show to publish it again.
//
// Hiding is not archiving and is not denial: a hidden photo stays approved, stays in the
// master store and stays eligible for training. Only its public copies go away. An archived
// photo also keeps its master file and its row; it just stops counting anywhere.
//
// A SCAN CONTRIBUTION (plant_images.origin = 'scan_contribution') is a private, training-only
// photo. It is never public, so restore (Show) and primary refuse it outright, before anything
// is built or changed. Archive and unarchive still work on it: archive is the admin's only
// removal tool for these photos.
//
// The database and the file builders are injected (`deps`) so the order of the steps
// can be tested without MySQL or sharp. Callers normally pass nothing.

const publicImages = require('./public-images');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// plant_images.archiveReason is VARCHAR(255).
const ARCHIVE_REASON_MAX = 255;

const fail = (error, code = 400, extra = {}) => ({ error, code, ...extra });

// plant_images.origin: 'record' (the normal record flow) or 'scan_contribution' (a private,
// training-only photo from a scan). A row read without the column counts as a normal photo.
const SCAN_CONTRIBUTION = 'scan_contribution';
const isScanContribution = (photo) => Boolean(photo) && photo.origin === SCAN_CONTRIBUTION;

const scanContributionRefusal = (action) => fail(
    `A scan contribution is a private training photo and can never be ${action}. You can archive it.`,
    409, { reason: 'scan_contribution' }
);

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
async function listPlantPhotos(plantId, deps, options = {}) {
    const bad = checkIds(plantId);
    if (bad) return bad;
    const { db } = resolveDeps(deps);
    const [plants] = await db.query('SELECT plantId, archivedAt FROM plants WHERE plantId = ?', [plantId]);
    if (plants.length === 0) return fail('Plant not found', 404);
    const plantArchived = Boolean(plants[0].archivedAt);

    // The admin editor asks for ONE group at a time, one page at a time (options.pageSize), so
    // opening a plant with hundreds of photos stays light. No pageSize = every photo, as before.
    if (options && options.pageSize) return listPlantPhotoPage(db, plantId, plantArchived, options);

    const [rows] = await db.query(
        `SELECT i.imageId, i.status, i.isPrimary, i.publicVisible, i.archivedAt, i.archiveReason, i.deletedAt, i.uploadedAt,
                i.thumbnailHash, i.displayHash, i.origin, i.contributionConfidence, i.contributionModelId,
                a.username AS uploadedByName
         FROM plant_images i
         JOIN accounts a ON a.accountId = i.accountId
         WHERE i.plantId = ? AND i.status = 'approved'
         ORDER BY i.isPrimary DESC, i.uploadedAt ASC`,
        [plantId]
    );
    return {
        plantId,
        plantArchived,
        photos: rows.map((r) => photoRow(r, plantArchived))
    };
}

function photoRow(r, plantArchived) {
    return {
        imageId: r.imageId,
        status: r.status,
        isPrimary: Boolean(r.isPrimary),
        publicVisible: Boolean(r.publicVisible),
        archived: Boolean(r.archivedAt),
        archivedAt: r.archivedAt || null,
        archiveReason: r.archiveReason || null,
        // Deleted status (Archive page): waiting for the retention days. Unarchive is refused until it is undone.
        deleted: Boolean(r.deletedAt),
        deletedAt: r.deletedAt || null,
        // 'record' or 'scan_contribution'. A contribution is private: the admin panel offers
        // Archive / Unarchive only. contributionConfidence is a number (the column is DECIMAL,
        // which the driver returns as text) or null.
        origin: r.origin || 'record',
        scanContribution: isScanContribution(r),
        contributionConfidence: isScanContribution(r) && r.contributionConfidence !== null && r.contributionConfidence !== undefined
            ? Number(r.contributionConfidence) : null,
        contributionModelId: isScanContribution(r) ? (r.contributionModelId || null) : null,
        // Visible to the public right now: the same rule the public queries use.
        publicNow: Boolean(r.publicVisible) && !r.archivedAt && Boolean(r.thumbnailHash) && Boolean(r.displayHash)
            && !plantArchived,
        uploadedAt: r.uploadedAt,
        uploadedByName: r.uploadedByName,
        previewUrl: `/admin/api/plant-images/${encodeURIComponent(r.imageId)}`
    };
}

/**
 * One page of one group. group 'record' = photos from the normal record flow; 'scan_contribution' =
 * the private training-only photos. Carries each photo's own training fields (an archived photo has
 * none: it is out of training) and the size of BOTH groups, so the panel can label its two sections
 * without loading the other one. A page past the end is moved back to the last page.
 */
async function listPlantPhotoPage(db, plantId, plantArchived, options) {
    const group = options.group === SCAN_CONTRIBUTION ? SCAN_CONTRIBUTION : 'record';
    const pageSize = Math.max(1, Math.min(parseInt(options.pageSize, 10) || 1, 100));

    const [counted] = await db.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(origin = 'scan_contribution'), 0) AS scan
         FROM plant_images WHERE plantId = ? AND status = 'approved'`,
        [plantId]
    );
    const total = Number(counted[0].total) || 0;
    const scan = Number(counted[0].scan) || 0;
    const counts = { record: total - scan, scan_contribution: scan };
    const groupTotal = counts[group];
    const pages = Math.max(1, Math.ceil(groupTotal / pageSize));
    const page = Math.min(Math.max(parseInt(options.page, 10) || 1, 1), pages);

    const where = group === SCAN_CONTRIBUTION
        ? "i.origin = 'scan_contribution'"
        : "(i.origin IS NULL OR i.origin <> 'scan_contribution')";
    // Newest first for contributions (there is no primary among them); primary first, then oldest, for the rest.
    const order = group === SCAN_CONTRIBUTION
        ? 'i.uploadedAt DESC, i.imageId ASC'
        : 'i.isPrimary DESC, i.uploadedAt ASC, i.imageId ASC';
    const [rows] = await db.query(
        `SELECT i.imageId, i.status, i.isPrimary, i.publicVisible, i.archivedAt, i.archiveReason, i.deletedAt, i.uploadedAt,
                i.thumbnailHash, i.displayHash, i.origin, i.contributionConfidence, i.contributionModelId,
                i.trainingStatus, i.trainingReason, i.part, i.groupKey, i.masterPurgedAt,
                a.username AS uploadedByName
         FROM plant_images i
         JOIN accounts a ON a.accountId = i.accountId
         WHERE i.plantId = ? AND i.status = 'approved' AND ${where}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
        [plantId, pageSize, (page - 1) * pageSize]
    );
    return {
        plantId,
        plantArchived,
        group,
        page,
        pages,
        pageSize,
        total: groupTotal,
        counts,
        photos: rows.map((r) => ({
            ...photoRow(r, plantArchived),
            // Same rule as the training list: archived or purged photos are not in training.
            training: r.archivedAt || r.masterPurgedAt ? null : {
                imageId: r.imageId,
                trainingStatus: r.trainingStatus,
                trainingReason: r.trainingReason || '',
                part: r.part || '',
                groupKey: r.groupKey || ''
            }
        }))
    };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

async function loadPhoto(conn, plantId, imageId) {
    const [rows] = await conn.query(
        `SELECT imageId, plantId, status, isPrimary, publicVisible, archivedAt, storedPath, origin, deletedAt
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
    // Before anything is built: a refused photo must not get public files written for it.
    if (isScanContribution(photo)) return scanContributionRefusal('shown');
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

/**
 * Checks the optional archive reason. Returns { reason } (null when empty) or { error, code }.
 * A reason that is not text is refused rather than turned into "[object Object]".
 */
function cleanReason(input) {
    if (input === undefined || input === null) return { reason: null };
    if (typeof input !== 'string') return fail('The archive reason must be text', 400);
    const reason = input.split(/\s+/).filter(Boolean).join(' ');
    if (reason.length > ARCHIVE_REASON_MAX) {
        return fail(`The archive reason can be at most ${ARCHIVE_REASON_MAX} characters`, 400);
    }
    return { reason: reason || null };
}

/**
 * Archives one approved photo. Order: delete the public files, then set the archive columns,
 * the hidden flag and the primary hand-over in one transaction, then delete once more.
 *
 * options: { reason?: string, accountId?: string }. accountId is the admin doing it and goes
 * into archivedBy (it is a foreign key, so it must be a real account or null).
 * Returns { ok: true, plantId, imageId, wasPrimary, archiveReason } or { error, code }.
 */
async function archivePhoto(plantId, imageId, options = {}, deps) {
    const bad = checkIds(plantId, imageId);
    if (bad) return bad;
    const checked = cleanReason(options && options.reason);
    if (checked.error) return checked;
    const accountId = (options && options.accountId) || null;
    const { db, remove } = resolveDeps(deps);

    const photo = await inTransaction(db, async (conn) => loadPhoto(conn, plantId, imageId));
    if (!photo) return fail('Photo not found on this plant', 404);
    if (photo.status !== 'approved') return fail('Only an approved photo can be archived', 409);
    if (photo.archivedAt) return fail('This photo is already archived', 409);

    // 1. Files first. A failure here leaves the database untouched, so the photo is still
    //    visible and still not archived, and the admin is told so.
    try {
        await remove(plantId, imageId);
    } catch (err) {
        console.error(`Archive ${imageId}: public copies could not be deleted: ${err.message}`);
        return fail(
            `The public file could not be deleted (${err.code || err.message}), so the photo is not archived and is still visible. ` +
            'Close anything that has the file open and try again.',
            500, { reason: 'delete_failed' }
        );
    }

    // 2. Then the archive columns, hidden for good measure, and a new primary if this one was it.
    const result = await inTransaction(db, async (conn) => {
        const again = await loadPhoto(conn, plantId, imageId);
        if (!again) return fail('Photo not found on this plant', 404);
        if (again.archivedAt) return fail('This photo is already archived', 409);
        await conn.query(
            `UPDATE plant_images
             SET archivedAt = NOW(), archivedBy = ?, archiveReason = ?,
                 publicVisible = FALSE, thumbnailHash = NULL, displayHash = NULL, isPrimary = FALSE
             WHERE imageId = ?`,
            [accountId, checked.reason, imageId]
        );
        await reassignPrimary(conn, plantId);
        return { ok: true, plantId, imageId, wasPrimary: Boolean(photo.isPrimary), archiveReason: checked.reason };
    });
    if (result.error) return result;

    // 3. A regeneration that ran between steps 1 and 2 (the startup catch-up) would have
    //    written the files back; delete once more so the end state is certain.
    try {
        await remove(plantId, imageId);
    } catch (err) {
        console.error(`Archive ${imageId}: second delete failed: ${err.message}`);
        return fail(
            'The photo is archived, but a public file could not be removed. Try Archive again, or hide it.',
            500, { reason: 'delete_failed_after_flag' }
        );
    }
    return result;
}

/**
 * Takes a photo out of the archive. It does NOT make it public: the photo comes back
 * hidden (archivePhoto set publicVisible = FALSE) and stays that way until an admin presses
 * Show. Returns { ok: true, plantId, imageId } or { error, code }.
 */
async function unarchivePhoto(plantId, imageId, deps) {
    const bad = checkIds(plantId, imageId);
    if (bad) return bad;
    const { db } = resolveDeps(deps);
    return inTransaction(db, async (conn) => {
        const photo = await loadPhoto(conn, plantId, imageId);
        if (!photo) return fail('Photo not found on this plant', 404);
        if (photo.status !== 'approved') return fail('Only an approved photo can be unarchived', 409);
        if (!photo.archivedAt) return fail('This photo is not archived', 409);
        if (photo.deletedAt) return fail('This photo is waiting to be deleted. Undo the deletion first.', 409);
        await conn.query(
            'UPDATE plant_images SET archivedAt = NULL, archivedBy = NULL, archiveReason = NULL WHERE imageId = ?',
            [imageId]
        );
        return { ok: true, plantId, imageId };
    });
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
        if (isScanContribution(photo)) return scanContributionRefusal('the primary photo');
        if (photo.archivedAt) return fail('An archived photo cannot be the primary photo', 409);
        if (!photo.publicVisible) return fail('A hidden photo cannot be the primary photo. Show it first.', 409);
        await conn.query('UPDATE plant_images SET isPrimary = FALSE WHERE plantId = ? AND isPrimary = TRUE', [plantId]);
        await conn.query('UPDATE plant_images SET isPrimary = TRUE WHERE imageId = ?', [imageId]);
        return { ok: true, plantId, imageId };
    });
}

module.exports = { listPlantPhotos, hidePhoto, restorePhoto, setPrimaryPhoto, archivePhoto, unarchivePhoto, reassignPrimary };
