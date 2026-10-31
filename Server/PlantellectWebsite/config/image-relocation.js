// Moving photos between the pending / approved / denied folders, and keeping
// plant_images.storedPath / discovery_images.storedPath in step with the files.
//
// Every function here COPIES + VERIFIES through a FileMovePlan (see
// image-files.js). They run INSIDE the caller's transaction and only stage
// copies and write rows; the caller commits and then calls plan.finalize() (which
// deletes the old files) or, on rollback, plan.rollback() (which deletes the
// copies). A row therefore never points at a file that is not there.
//
// When a photo cannot be copied cleanly after settings.plantImages.copyMaxAttempts
// tries, its row keeps the OLD storedPath (the file is still there and still
// served) and gets fileIssue / fileIssueAt set. The admin sees those on the
// plants page and can retry from there (retryImageIssue below).

const path = require('path');
const { mysqlPool } = require('./pool-mysql');
const files = require('./image-files');

const KINDS = { plant: 'plant', discovery: 'discovery' };

function describeFailure(result) {
    const attempts = result.attempts || 0;
    const reason = result.error || 'unknown error';
    return attempts > 0
        ? `Could not copy the photo cleanly after ${attempts} attempts: ${reason}`
        : `Could not move the photo: ${reason}`;
}

async function setIssue(conn, table, imageId, message) {
    await conn.query(
        `UPDATE \`${table}\` SET fileIssue = ?, fileIssueAt = NOW() WHERE imageId = ?`,
        [String(message).slice(0, 500), imageId]
    );
}

/**
 * Plant photos -> the folder for `status`.
 *   approved -> plants/approved/<plantId>/
 *   pending  -> plants/pending/<requestId>/
 *   rejected -> plants/denied/<requestId>/
 * Returns { moved, failed: [{ imageId, message }] }.
 */
async function relocatePlantImages(conn, plan, { imageIds, status, requestId, plantId }) {
    const result = { moved: 0, failed: [] };
    const ids = [...new Set((imageIds || []).filter(Boolean))];
    if (ids.length === 0) return result;

    const key = status === 'approved' ? plantId : requestId;
    if (!key) throw new Error(`relocatePlantImages needs a ${status === 'approved' ? 'plantId' : 'requestId'}`);
    const targetDir = files.plantRelativeDir(status, key);

    const [rows] = await conn.query(
        `SELECT imageId, storedPath, mimeType FROM plant_images
         WHERE imageId IN (${ids.map(() => '?').join(',')})`,
        ids
    );

    for (const row of rows) {
        const newRelative = path.join(targetDir, path.basename(row.storedPath));
        // A master never moves: the review status lives in the database, not in the folder.
        if (files.isPlantMasterPath(row.storedPath)
            || path.normalize(row.storedPath) === path.normalize(newRelative)) {
            await conn.query('UPDATE plant_images SET fileIssue = NULL, fileIssueAt = NULL WHERE imageId = ?', [row.imageId]);
            continue;
        }
        const source = path.join(files.plantRoot(), row.storedPath);
        const destination = path.join(files.plantRoot(), newRelative);
        const copied = await plan.stage(source, destination, { mimeType: row.mimeType });
        if (copied.ok) {
            await conn.query(
                'UPDATE plant_images SET storedPath = ?, fileIssue = NULL, fileIssueAt = NULL WHERE imageId = ?',
                [newRelative, row.imageId]
            );
            result.moved++;
        } else {
            const message = describeFailure(copied);
            await setIssue(conn, 'plant_images', row.imageId, message);
            result.failed.push({ imageId: row.imageId, message });
        }
    }
    return result;
}

/**
 * Every photo of a discovery report -> the folder for the report's new status.
 * `status` is the approval_requests status: approved | denied | rejected | pending.
 * storedPath stays relative to the discovery root (<state>/<requestId>/<file>).
 */
async function relocateDiscoveryImages(conn, plan, requestId, status) {
    const result = { moved: 0, failed: [] };
    if (!requestId || !files.folderState(status)) return result;
    const targetDir = files.discoveryRelativeDir(status, requestId);

    const [rows] = await conn.query(
        'SELECT imageId, storedPath, mimeType FROM discovery_images WHERE requestId = ?',
        [requestId]
    );
    for (const row of rows) {
        const newRelative = path.join(targetDir, path.basename(row.storedPath));
        // A master never moves, whatever the report's status.
        if (files.isDiscoveryMasterPath(row.storedPath)
            || path.normalize(row.storedPath) === path.normalize(newRelative)) {
            await conn.query('UPDATE discovery_images SET fileIssue = NULL, fileIssueAt = NULL WHERE imageId = ?', [row.imageId]);
            continue;
        }
        const source = path.join(files.discoveryRoot(), row.storedPath);
        const destination = path.join(files.discoveryRoot(), newRelative);
        const copied = await plan.stage(source, destination, { mimeType: row.mimeType });
        if (copied.ok) {
            await conn.query(
                'UPDATE discovery_images SET storedPath = ?, fileIssue = NULL, fileIssueAt = NULL WHERE imageId = ?',
                [newRelative, row.imageId]
            );
            result.moved++;
        } else {
            const message = describeFailure(copied);
            await setIssue(conn, 'discovery_images', row.imageId, message);
            result.failed.push({ imageId: row.imageId, message });
        }
    }
    return result;
}

/** After finalize(): remove the folders the move emptied. */
function tidyAfter(plan) {
    for (const dir of plan.sourceDirs()) {
        // The three state folders and the two roots are kept even when empty.
        const root = dir.startsWith(files.discoveryRoot() + path.sep) ? files.discoveryRoot() : files.plantRoot();
        const stateFolders = new Set(Object.values(require('./settings').plantImages.statusFolders));
        const parent = path.basename(path.dirname(dir));
        files.pruneEmptyDirs(dir, stateFolders.has(parent) ? path.dirname(dir) : root);
    }
}

/** The request that carried this photo (needed for the pending / denied folder name). */
async function findRequestIdForImage(conn, imageId) {
    const [rows] = await conn.query(
        `SELECT requestId FROM approval_requests
         WHERE requestType IN ('plant_addition','plant_contribution')
           AND JSON_CONTAINS(payload, JSON_QUOTE(?), '$.imageIds')
         ORDER BY createdAt DESC LIMIT 1`,
        [imageId]
    );
    return rows.length > 0 ? rows[0].requestId : null;
}

// ---------------------------------------------------------------------------
// The admin's view of problems, and the retry
// ---------------------------------------------------------------------------

async function listImageIssues() {
    const [plantRows] = await mysqlPool.query(
        `SELECT i.imageId, i.plantId, i.status, i.storedPath, i.fileIssue, i.fileIssueAt,
                p.commonName AS plantName
         FROM plant_images i LEFT JOIN plants p ON p.plantId = i.plantId
         WHERE i.fileIssue IS NOT NULL ORDER BY i.fileIssueAt ASC LIMIT 200`
    );
    const [discoveryRows] = await mysqlPool.query(
        `SELECT d.imageId, d.requestId, ar.status, d.storedPath, d.fileIssue, d.fileIssueAt
         FROM discovery_images d JOIN approval_requests ar ON ar.requestId = d.requestId
         WHERE d.fileIssue IS NOT NULL ORDER BY d.fileIssueAt ASC LIMIT 200`
    );
    return [
        ...plantRows.map((r) => ({
            kind: KINDS.plant,
            imageId: r.imageId,
            plantId: r.plantId,
            plantName: r.plantName || null,
            status: r.status,
            storedPath: r.storedPath,
            message: r.fileIssue,
            since: r.fileIssueAt
        })),
        ...discoveryRows.map((r) => ({
            kind: KINDS.discovery,
            imageId: r.imageId,
            requestId: r.requestId,
            status: r.status,
            storedPath: r.storedPath,
            message: r.fileIssue,
            since: r.fileIssueAt
        }))
    ];
}

/**
 * Admin retry for one flagged photo: the same copy / verify / delete, aimed at
 * the folder its CURRENT status belongs in. Returns { ok, message }.
 */
async function retryImageIssue(kind, imageId) {
    if (kind !== KINDS.plant && kind !== KINDS.discovery) {
        return { error: 'kind must be "plant" or "discovery"', code: 400 };
    }
    const conn = await mysqlPool.getConnection();
    const plan = new files.FileMovePlan();
    try {
        await conn.beginTransaction();
        let outcome;

        if (kind === KINDS.plant) {
            const [rows] = await conn.query(
                'SELECT imageId, plantId, status FROM plant_images WHERE imageId = ? AND fileIssue IS NOT NULL FOR UPDATE',
                [imageId]
            );
            if (rows.length === 0) {
                await conn.rollback();
                return { error: 'That photo has no file problem to retry', code: 404 };
            }
            const row = rows[0];
            const requestId = row.status === 'approved' ? null : await findRequestIdForImage(conn, imageId);
            if (row.status !== 'approved' && !requestId) {
                await conn.rollback();
                return { error: 'The request that carried this photo could not be found', code: 409 };
            }
            if (row.status === 'approved' && !row.plantId) {
                await conn.rollback();
                return { error: 'An approved photo has no plant to file it under', code: 409 };
            }
            outcome = await relocatePlantImages(conn, plan, {
                imageIds: [imageId], status: row.status, requestId, plantId: row.plantId
            });
        } else {
            const [rows] = await conn.query(
                `SELECT d.imageId, d.requestId, ar.status
                 FROM discovery_images d JOIN approval_requests ar ON ar.requestId = d.requestId
                 WHERE d.imageId = ? AND d.fileIssue IS NOT NULL FOR UPDATE`,
                [imageId]
            );
            if (rows.length === 0) {
                await conn.rollback();
                return { error: 'That photo has no file problem to retry', code: 404 };
            }
            if (!files.folderState(rows[0].status)) {
                await conn.rollback();
                return { error: `A ${rows[0].status} report keeps no photos`, code: 409 };
            }
            // relocateDiscoveryImages works on the whole report: its other photos
            // are already in place, so they are simply confirmed.
            outcome = await relocateDiscoveryImages(conn, plan, rows[0].requestId, rows[0].status);
        }

        await conn.commit();
        await plan.finalize();
        tidyAfter(plan);
        if (outcome.failed.length > 0) {
            return { ok: false, message: outcome.failed[0].message };
        }
        return { ok: true, message: 'The photo was copied, checked and filed.' };
    } catch (err) {
        await conn.rollback().catch(() => {});
        await plan.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = {
    KINDS,
    relocatePlantImages,
    relocateDiscoveryImages,
    tidyAfter,
    findRequestIdForImage,
    listImageIssues,
    retryImageIssue,
    describeFailure
};
