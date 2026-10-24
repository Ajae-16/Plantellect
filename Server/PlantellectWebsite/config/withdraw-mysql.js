// A botanist withdrawing their OWN pending submission.
//
// Applies to the four botanist request types listed in MY_REQUEST_TYPES (record-mysql.js):
// new plant, contribution, taxonomy update and change request. Only the submitter can do it,
// only while the request is still 'pending', and the row is kept with status 'cancelled'
// (the status the schema already has for "the submitter withdrew it"), so the history stays.
//
// Photos that were waiting in review are marked 'rejected' and filed under plants/denied/<requestId>/
// exactly like an admin denial does, so they never reach the library or the training set.
// A discovery report the submission came from is NOT touched: the botanist's claim on the
// report stays, so they can submit again.

const { mysqlPool } = require('./pool-mysql');
const { parsePayload } = require('./shared-mysql');
const imageFiles = require('./image-files');
const relocation = require('./image-relocation');

const WITHDRAWABLE = ['plant_addition', 'plant_contribution', 'plant_taxonomy', 'plant_change'];

async function withdrawMyRequest(accountId, requestId) {
    const conn = await mysqlPool.getConnection();
    const plan = new imageFiles.FileMovePlan();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT requestId, requestType, status, payload
             FROM approval_requests
             WHERE requestId = ? AND accountId = ? FOR UPDATE`,
            [requestId, accountId]
        );
        // Someone else's request reads as "not found": its existence is not theirs to learn.
        if (rows.length === 0 || !WITHDRAWABLE.includes(rows[0].requestType)) {
            await conn.rollback();
            return { error: 'Submission not found', code: 404 };
        }
        const request = rows[0];
        if (request.status !== 'pending') {
            await conn.rollback();
            return {
                error: request.status === 'cancelled'
                    ? 'This submission was already withdrawn'
                    : `This submission was already ${request.status} and can no longer be withdrawn`,
                code: 409
            };
        }

        const payload = parsePayload(request.payload);
        const imageIds = Array.isArray(payload.imageIds) ? payload.imageIds.filter(Boolean) : [];
        let photoFileProblems = [];
        if (imageIds.length > 0) {
            await conn.query(
                `UPDATE plant_images SET status = 'rejected', reviewedAt = NOW()
                 WHERE accountId = ? AND status = 'pending' AND imageId IN (${imageIds.map(() => '?').join(',')})`,
                [accountId, ...imageIds]
            );
            const moves = await relocation.relocatePlantImages(conn, plan, {
                imageIds, status: 'rejected', requestId
            });
            photoFileProblems = moves.failed;
        }

        const [result] = await conn.query(
            `UPDATE approval_requests
             SET status = 'cancelled', note = ?
             WHERE requestId = ? AND accountId = ? AND status = 'pending'`,
            ['[system] Withdrawn by the submitter.', requestId, accountId]
        );
        if (result.affectedRows === 0) {
            // An admin decided it between the read and the write.
            await conn.rollback();
            await plan.rollback();
            return { error: 'This submission was just decided and can no longer be withdrawn', code: 409 };
        }

        await conn.commit();
        await plan.finalize();
        relocation.tidyAfter(plan);
        return { requestId, status: 'cancelled', photoFileProblems };
    } catch (err) {
        await conn.rollback().catch(() => {});
        await plan.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = { withdrawMyRequest, WITHDRAWABLE };
