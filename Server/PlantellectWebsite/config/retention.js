// Retention job for denied photos (dataset handler).
//
// A photo that was denied (or withdrawn by its submitter) keeps its master for
// settings.plantImages.deniedRetentionDays days, so a contributor can still see what was
// refused. After that this nightly job deletes the master and keeps a TOMBSTONE:
//
//   denied_photo_tombstones (contentHash, perceptualHash, reason, deniedAt, purgedAt)
//
// No image, no account, no filename and no reviewer note, so nothing in it identifies a
// person. A later upload with the same hash can be recognised with findTombstone().
//
// Only photos with status 'rejected' are ever touched. Pending and approved photos are
// never deleted by this job, however old they are, and neither are discovery photos (those
// have their own purge in config/discovery-mysql.js).
//
// Order, for each photo, so a failure can only leave something harmless behind:
//
//   1. write the tombstone         (a tombstone for a photo that still exists is harmless)
//   2. claim the row               UPDATE ... SET masterPurgedAt = NOW() WHERE status = 'rejected'
//                                  AND masterPurgedAt IS NULL. It carries the status check and
//                                  stops two runs from handling the same photo.
//   3. delete the public copies    normally none: a denied photo never had any
//   4. delete the master           if this fails the claim is undone and the photo is retried
//                                  the next night
//
// The row is kept: the submitter's own view still says what happened, and the file routes
// already answer "Image file not found on disk" for a purged photo.

const fsp = require('fs').promises;
const path = require('path');
const settings = require('./settings');
const imageFiles = require('./image-files');
const publicImages = require('./public-images');

const DAY_MS = 24 * 60 * 60 * 1000;
const defaultExecutor = () => require('./pool-mysql').mysqlPool;

/**
 * The reason code kept in the tombstone, from the request that carried the photo:
 *   cancelled -> withdrawn      the submitter took it back
 *   approved  -> not_approved   the request was approved but this photo was not
 *   anything else -> denied
 * A code, not the reviewer's note: a note can name a person.
 */
async function reasonFor(db, imageId) {
    try {
        const [rows] = await db.query(
            `SELECT ar.status FROM approval_requests ar
             WHERE ar.requestType IN ('plant_addition','plant_contribution')
               AND JSON_CONTAINS(ar.payload, JSON_QUOTE(?), '$.imageIds')
             ORDER BY ar.createdAt DESC LIMIT 1`,
            [imageId]
        );
        const status = rows[0] && rows[0].status;
        if (status === 'cancelled') return 'withdrawn';
        if (status === 'approved') return 'not_approved';
    } catch (err) {
        console.error(`Retention: could not read the reason for ${imageId}: ${err.message}`);
    }
    return 'denied';
}

/**
 * Deletes the masters of photos denied longer than the retention setting.
 * Options (for tests): executor, now, days, batch, reason, removeFile, removeCopies.
 * Returns { checked, purged, tombstones, failed }. Never throws.
 */
async function purgeDeniedPhotos(options = {}) {
    const result = { checked: 0, purged: 0, tombstones: 0, failed: 0 };
    try {
        const db = options.executor || defaultExecutor();
        const now = options.now !== undefined ? new Date(options.now) : new Date();
        const days = Math.max(1, options.days !== undefined ? options.days : settings.plantImages.deniedRetentionDays);
        const batch = options.batch !== undefined ? options.batch : settings.plantImages.retentionBatchSize;
        const cutoff = new Date(now.getTime() - days * DAY_MS);
        const decide = options.reason || ((imageId) => reasonFor(db, imageId));
        const removeFile = options.removeFile || ((file) => fsp.unlink(file));
        const removeCopies = options.removeCopies || publicImages.removePublicCopies;

        const [rows] = await db.query(
            `SELECT imageId, plantId, storedPath, contentHash, perceptualHash, reviewedAt
             FROM plant_images
             WHERE status = 'rejected' AND masterPurgedAt IS NULL
               AND reviewedAt IS NOT NULL AND reviewedAt < ?
             ORDER BY reviewedAt ASC LIMIT ?`,
            [cutoff, batch]
        );

        for (const row of rows) {
            result.checked++;
            try {
                const file = publicImages.masterFileOf(row.storedPath);
                if (!file) {
                    // A path that leaves the image folder is never deleted.
                    result.failed++;
                    console.error(`Retention: ${row.imageId} has a path outside the image folder; left alone`);
                    continue;
                }

                if (row.contentHash) {
                    await db.query(
                        `INSERT INTO denied_photo_tombstones (contentHash, perceptualHash, reason, deniedAt)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                           reason = VALUES(reason),
                           perceptualHash = COALESCE(VALUES(perceptualHash), perceptualHash),
                           deniedAt = GREATEST(COALESCE(deniedAt, VALUES(deniedAt)), VALUES(deniedAt))`,
                        [row.contentHash, row.perceptualHash || null, await decide(row.imageId), row.reviewedAt]
                    );
                    result.tombstones++;
                }

                const [claimed] = await db.query(
                    `UPDATE plant_images SET masterPurgedAt = NOW()
                     WHERE imageId = ? AND status = 'rejected' AND masterPurgedAt IS NULL`,
                    [row.imageId]
                );
                if (!claimed.affectedRows) continue;

                try {
                    if (row.plantId) await removeCopies(row.plantId, row.imageId);
                    try {
                        await removeFile(file);
                    } catch (err) {
                        if (err.code !== 'ENOENT') throw err;
                    }
                } catch (err) {
                    await db.query('UPDATE plant_images SET masterPurgedAt = NULL WHERE imageId = ?', [row.imageId]);
                    throw err;
                }

                const masters = path.join(imageFiles.plantRoot(), settings.plantImages.plantSubdir);
                imageFiles.pruneEmptyDirs(path.dirname(file), masters);
                result.purged++;
            } catch (err) {
                result.failed++;
                console.error(`Retention: could not purge ${row.imageId}: ${err.message}`);
            }
        }
    } catch (err) {
        result.failed++;
        console.error('Retention failed:', err.message);
    }
    return result;
}

/**
 * The tombstone of a photo with this upload hash, or null. Lets a later feature say
 * "this exact file was denied before". Never throws.
 */
async function findTombstone(executor, contentHash) {
    if (!/^[0-9a-f]{64}$/.test(String(contentHash || ''))) return null;
    try {
        const [rows] = await (executor || defaultExecutor()).query(
            'SELECT contentHash, reason, deniedAt, purgedAt FROM denied_photo_tombstones WHERE contentHash = ? LIMIT 1',
            [contentHash]
        );
        return rows[0] || null;
    } catch (err) {
        console.error('Tombstone lookup failed:', err.message);
        return null;
    }
}

function describe(result) {
    if (result.checked === 0 && result.failed === 0) return null;
    return `Denied photo retention: ${result.purged} purged, ${result.tombstones} tombstone(s) written, ${result.failed} failed, ${result.checked} checked`;
}

module.exports = { purgeDeniedPhotos, findTombstone, reasonFor, describe };
