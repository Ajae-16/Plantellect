// Admin: requests (the unified review queue).
// Split out of mysql.js; see mysql.js for the combined export list.

const { logImageReview } = require('../mongoose-schemas/Imgreview.js');
const approvalMode = require('./approval-mode.js');
const { mysqlPool } = require('./pool-mysql');
const { parsePaging } = require('./shared-mysql');
const { bumpPermissionsVersion } = require('./auth-mysql');

// ---------------------------------------------------------------------------
// Admin: requests (the unified review queue)
// ---------------------------------------------------------------------------

async function listPendingRoleRequests() {
    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.accountId, ar.requestedRole, ar.status, ar.createdAt,
                ar.note, a.email, a.username,
                pr.firstName, pr.lastName,
                c.certificateId, c.originalFilename AS certificateFilename,
                c.mimeType AS certificateMimeType, c.size AS certificateSize
         FROM approval_requests ar
         JOIN accounts a ON ar.accountId = a.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         LEFT JOIN certificates c ON c.certificateId = (
             SELECT c2.certificateId FROM certificates c2
             WHERE c2.accountId = ar.accountId
             ORDER BY c2.uploadedAt DESC LIMIT 1
         )
         WHERE ar.status = 'pending' AND ar.requestType = 'role_permission'
         ORDER BY ar.createdAt ASC`
    );
    return rows.map((r) => ({
        requestId: r.requestId,
        accountId: r.accountId,
        requestedRole: r.requestedRole,
        status: r.status,
        createdAt: r.createdAt,
        requestedAt: r.createdAt,
        note: r.note,
        email: r.email,
        username: r.username,
        fullName: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.username,
        hasCertificate: Boolean(r.certificateId),
        certificate: r.certificateId
            ? {
                certificateId: r.certificateId,
                url: `/admin/certificates/${encodeURIComponent(r.accountId)}`,
                filename: r.certificateFilename,
                mimeType: r.certificateMimeType,
                size: r.certificateSize
            }
            : null
    }));
}

/**
 * Plant-facing view of the queue. A plant_addition draft lives in `payload`, so
 * its name and type are read from there; a contribution points at targetPlantId.
 */
async function listPlantRequests({ requestType, page, pageSize }) {
    const paging = parsePaging({ page, pageSize });
    const where = ["ar.status = 'pending'", "ar.requestType IN ('plant_addition','plant_contribution')"];
    const params = [];

    if (requestType) {
        where.push('ar.requestType = ?');
        params.push(requestType);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.requestType, ar.targetPlantId, ar.payload, ar.createdAt, ar.note,
                ar.approvalMode,
                a.accountId AS submitterId, a.username AS submitterName,
                pr.firstName AS submitterFirstName, pr.lastName AS submitterLastName,
                p.commonName AS targetCommonName, t.typeName AS targetType, t.label AS targetTypeLabel
         FROM approval_requests ar
         JOIN accounts a ON ar.accountId = a.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         LEFT JOIN plants p ON ar.targetPlantId = p.plantId
         LEFT JOIN plant_types t ON p.typeId = t.typeId
         ${whereSql}
         ORDER BY ar.createdAt ASC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );

    // Must carry the same alias as the row query: whereSql references ar.*, so a
    // count without the alias cannot resolve it.
    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total FROM approval_requests ar ${whereSql}`,
        params
    );

    return {
        requests: rows.map((r) => {
            let payload = {};
            try {
                payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
            } catch (err) {
                payload = {};
            }
            const isAddition = r.requestType === 'plant_addition';
            const fullName = [r.submitterFirstName, r.submitterLastName].filter(Boolean).join(' ');
            const imageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
            return {
                id: r.requestId,
                requestType: r.requestType,
                plantName: isAddition ? (payload.commonName || '(unnamed draft)') : r.targetCommonName,
                type: isAddition ? (payload.typeName || null) : r.targetType,
                typeLabel: isAddition ? (payload.typeLabel || null) : r.targetTypeLabel,
                targetPlantId: r.targetPlantId,
                submittedBy: r.submitterId,
                // Full name when the profile has one, username as the fallback.
                submittedByName: fullName || r.submitterName,
                requestedAt: r.createdAt,
                note: r.note,
                // Always present so the row shape is stable, and read from SQL
                // rather than from Mongo: logImageReview swallows its own errors,
                // so a failed audit write must not be able to make a decided
                // request look undecided. A pending row is 'manual' by definition —
                // nothing has decided it yet.
                approvalMode: r.approvalMode || 'manual',
                hasDescription: Boolean(payload.uses || payload.benefits || payload.harmful || payload.parts),
                images: imageIds.map((imageId) => ({
                    imageId,
                    url: `/admin/api/plant-images/${encodeURIComponent(imageId)}`
                })),
                payload
            };
        }),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize
    };
}

/** Everything the admin needs to review one plant request, including files. */
async function getRequestDetail(requestId) {
    const [rows] = await mysqlPool.query(
        `SELECT ar.*, a.username AS submitterName, a.email AS submitterEmail
         FROM approval_requests ar
         JOIN accounts a ON ar.accountId = a.accountId
         WHERE ar.requestId = ?`,
        [requestId]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    let payload = {};
    try {
        payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
    } catch (err) {
        payload = {};
    }

    const imageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
    let images = [];
    if (imageIds.length > 0) {
        const placeholders = imageIds.map(() => '?').join(',');
        const [imgRows] = await mysqlPool.query(
            `SELECT imageId, originalFilename, mimeType, size, status
             FROM plant_images WHERE imageId IN (${placeholders})`,
            imageIds
        );
        images = imgRows;
    }

    return {
        requestId: row.requestId,
        requestType: row.requestType,
        requestedRole: row.requestedRole,
        targetPlantId: row.targetPlantId,
        status: row.status,
        note: row.note,
        createdAt: row.createdAt,
        reviewedAt: row.reviewedAt,
        submittedBy: row.accountId,
        submittedByName: row.submitterName,
        submittedByEmail: row.submitterEmail,
        payload,
        images
    };
}

async function claimPendingRequest(conn, requestId) {
    const [rows] = await conn.query(
        'SELECT * FROM approval_requests WHERE requestId = ? AND status = ? FOR UPDATE',
        [requestId, 'pending']
    );
    return rows[0] || null;
}

/**
 * Settles a request and records HOW it was settled.
 *
 * `approvalMode` is written on every approve and every deny, under either mode,
 * because the column is the queue's only source of truth about that: the audit
 * collection is Mongo, and logImageReview swallows its own errors, so a logging
 * outage would otherwise leave a real decision with no record of it. The queue
 * reads this column, never Mongo.
 *
 * It is DERIVED from the reviewer rather than passed in, so it cannot disagree
 * with reviewedBy: there is no second value to set and no call site that can
 * supply the wrong one. That is what makes "a manual approve while the type is in
 * auto mode still records approvalMode = 'manual'" true by construction.
 */
async function finishRequest(conn, requestId, status, reviewerId, note) {
    const audit = approvalMode.auditContextFor(reviewerId);
    await conn.query(
        'UPDATE approval_requests SET status = ?, reviewedBy = ?, reviewedAt = NOW(), note = ?, approvalMode = ? WHERE requestId = ?',
        [status, reviewerId, note || null, audit.approvalMode, requestId]
    );
    return audit;
}

/**
 * The shared body of a role_permission decision.
 *
 * Lives here rather than in routes/role-requests.js because there are now two
 * callers — an admin clicking Approve, and the automatic pass — and two copies of
 * a privilege grant is exactly how they drift. The route's own inline transaction
 * was the second copy; this is the one, and the route now only maps HTTP onto it.
 *
 * Automatic approval of a role request is deliberately permitted and is NOT one of
 * the two publishing switches: it grants record_plant, and the certificate an
 * admin would have inspected is already required at registration. It changes a
 * permission, so it bumps permissions_version exactly as a manual approval does —
 * otherwise the account's live session would keep its old permission set until it
 * happened to log in again.
 */
async function decideRoleRequest(requestId, reviewerId, { approve, note, deleteCertificate } = {}) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // claimPendingRequest, not a bare SELECT: the same FOR UPDATE guard the
        // plant approvers take, so two callers cannot both grant the role.
        const request = await claimPendingRequest(conn, requestId);
        if (!request) {
            await conn.rollback();
            return { error: 'Pending role request not found or already resolved', code: 409 };
        }
        if (request.requestType !== 'role_permission') {
            await conn.rollback();
            return { error: 'Not a role request', code: 400 };
        }

        const accountId = request.accountId;
        const requestedRole = request.requestedRole;

        if (approve) {
            const [roleRows] = await conn.query('SELECT roleId FROM roles WHERE roleName = ?', [requestedRole]);
            if (roleRows.length === 0) {
                await conn.rollback();
                return { error: 'Invalid role', code: 400 };
            }
            await conn.query('UPDATE accounts SET roleId = ? WHERE accountId = ?', [roleRows[0].roleId, accountId]);
            await bumpPermissionsVersion(conn);
        }

        const audit = await finishRequest(
            conn,
            requestId,
            approve ? 'approved' : 'denied',
            reviewerId,
            note
        );

        // The certificate is only destroyed on an explicit denial, and only when
        // the caller asked for it — an approval must not lose the evidence.
        if (!approve && deleteCertificate) {
            const [certs] = await conn.query(
                'SELECT certificateId FROM certificates WHERE accountId = ?',
                [accountId]
            );
            for (const cert of certs) {
                await deleteCertificate(conn, cert.certificateId);
            }
        }

        await conn.commit();

        await logImageReview({
            requestId,
            requestType: request.requestType,
            imageId: null,
            plantId: null,
            accountId,
            decision: approve
                ? (audit.approvalMode === 'auto' ? 'auto_approved' : 'approved')
                : 'rejected',
            approvalMode: audit.approvalMode,
            decisionSource: audit.decisionSource,
            ruleVersion: audit.ruleVersion,
            reason: audit.reason,
            reviewedBy: reviewerId,
            note: note || ''
        });

        return {
            requestId,
            accountId,
            approvalMode: audit.approvalMode,
            ...(approve ? { newRole: requestedRole } : {})
        };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = {
    listPendingRoleRequests,
    listPlantRequests,
    getRequestDetail,
    claimPendingRequest,
    finishRequest,
    decideRoleRequest
};
