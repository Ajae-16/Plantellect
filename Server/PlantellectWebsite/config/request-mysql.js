// Admin: requests (the unified review queue).
// Split out of mysql.js; see mysql.js for the combined export list.

const approvalMode = require('./approval-mode.js');
const { mysqlPool } = require('./pool-mysql');
const { parsePaging } = require('./shared-mysql');

// ---------------------------------------------------------------------------
// Admin: requests (the unified review queue)
// ---------------------------------------------------------------------------

/**
 * Plant-facing view of the queue. A plant_addition draft lives in `payload`, so
 * its name and type are read from there; a contribution, a taxonomy update and a
 * change request point at targetPlantId. A taxonomy update carries
 * `taxonomyChanges`; a plant_change carries `changes` (field -> { from, to }) and
 * the contributor's `changeReason`, for the diff view.
 */
async function listPlantRequests({ requestType, page, pageSize }) {
    const paging = parsePaging({ page, pageSize });
    const where = [
        "ar.status = 'pending'",
        "ar.requestType IN ('plant_addition','plant_contribution','plant_taxonomy','plant_change')"
    ];
    const params = [];

    if (requestType) {
        where.push('ar.requestType = ?');
        params.push(requestType);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.requestType, ar.targetPlantId, ar.payload, ar.createdAt, ar.note,
                ar.approvalMode,
                a.accountId AS submitterId, a.username AS submitterName, rl.roleName AS submitterRole,
                pr.firstName AS submitterFirstName, pr.lastName AS submitterLastName,
                p.commonName AS targetCommonName, t.typeName AS targetType, t.toxicityLevel AS targetToxicity
         FROM approval_requests ar
         JOIN accounts a ON ar.accountId = a.accountId
         JOIN roles rl ON rl.roleId = a.roleId
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
            const isChange = r.requestType === 'plant_change';
            const fullName = [r.submitterFirstName, r.submitterLastName].filter(Boolean).join(' ');
            const imageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
            return {
                id: r.requestId,
                requestType: r.requestType,
                plantName: isAddition ? (payload.commonName || '(unnamed draft)') : r.targetCommonName,
                type: isAddition ? (payload.typeName || null) : r.targetType,
                typeLabel: isAddition ? (payload.typeName || null) : r.targetType,   // the name IS the label
                // The badge colour. An addition has no plant yet, so it comes from the
                // type the contributor described.
                toxicityLevel: isAddition
                    ? ((payload.typeSpec && payload.typeSpec.toxicityLevel) || 'none')
                    : (r.targetToxicity || 'none'),
                targetPlantId: r.targetPlantId,
                submittedBy: r.submitterId,
                // Full name when the profile has one, username as the fallback.
                submittedByName: fullName || r.submitterName,
                // Current role (superadmin / admin / contributor / user), for the badge.
                submittedByRole: r.submitterRole,
                submittedByUsername: r.submitterName,
                requestedAt: r.createdAt,
                note: r.note,
                // Always present so the row shape is stable, and read from SQL
                // rather than from Mongo: logImageReview swallows its own errors,
                // so a failed audit write must not be able to make a decided
                // request look undecided. A pending row is 'manual' by definition —
                // nothing has decided it yet.
                approvalMode: r.approvalMode || 'manual',
                hasDescription: Boolean(payload.uses || payload.benefits || payload.harmful || payload.parts),
                taxonomyChanges: r.requestType === 'plant_taxonomy' ? (payload.changes || {}) : null,
                taxonomyReason: r.requestType === 'plant_taxonomy' ? (payload.reason || null) : null,
                changes: isChange ? (payload.changes || {}) : null,
                changeReason: isChange ? (payload.reason || null) : null,
                // 'base' (plant info) or 'description' (one contributor's own description);
                // 'legacy' for a request filed before the split.
                changeScope: isChange ? (payload.scope || 'legacy') : null,
                changeDescriptionId: isChange ? (payload.descriptionId || null) : null,
                // The other contributor's answer, when the change is to their description.
                ownerApproval: isChange ? (payload.ownerApproval || null) : null,
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
        `SELECT ar.*, a.username AS submitterName, a.email AS submitterEmail, rl.roleName AS submitterRole,
                pr.firstName AS submitterFirstName, pr.lastName AS submitterLastName,
                p.commonName AS targetCommonName, p.scientificName AS targetScientificName,
                t.typeName AS targetType, t.toxicityLevel AS targetToxicity
         FROM approval_requests ar
         JOIN accounts a ON ar.accountId = a.accountId
         JOIN roles rl ON rl.roleId = a.roleId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         LEFT JOIN plants p ON p.plantId = ar.targetPlantId
         LEFT JOIN plant_types t ON t.typeId = p.typeId
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
        submittedByName: [row.submitterFirstName, row.submitterLastName].filter(Boolean).join(' ') || row.submitterName,
        submittedByUsername: row.submitterName,
        submittedByEmail: row.submitterEmail,
        submittedByRole: row.submitterRole,
        // The plant this request is about, so the reviewer sees what it applies to.
        targetPlant: row.targetPlantId ? {
            id: row.targetPlantId,
            commonName: row.targetCommonName,
            scientificName: row.targetScientificName,
            typeName: row.targetType,
            toxicityLevel: row.targetToxicity
        } : null,
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

module.exports = {
    listPlantRequests,
    getRequestDetail,
    claimPendingRequest,
    finishRequest
};