// Botanist submissions.
// Split out of mysql.js; see mysql.js for the combined export list.

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const settings = require('./settings');
const { insertRow } = require('./ids.js');
const { mysqlPool } = require('./pool-mysql');
const { normalizeName, normalizeScientificName, PARTS_FIELDS, hasAnyPartValue, loadModelClasses, parsePaging, parsePayload } = require('./shared-mysql');
const { assertDiscoveryClaim, linkDiscoveryRecord } = require('./discovery-mysql');

// ---------------------------------------------------------------------------
// Botanist submissions
// ---------------------------------------------------------------------------

/**
 * Validates a new-plant draft. Duplicate species is allowed on purpose.
 *
 * Returns { errors, warnings, clean }. The caller must store `clean`, not the
 * raw body: scientificName is a machine identifier, matched by equality against
 * the model's class list and by `WHERE scientificName IN (...)` in
 * resolveScientificNames. A leading space alone is enough to break both —
 * verified on this server (utf8mb4_0900_ai_ci): `' Ocimum basilicum' =
 * 'Ocimum basilicum'` is 0. `warnings` never blocks a submission.
 */
function validatePlantDraft(body) {
    const errors = [];
    const warnings = [];

    const clean = {
        commonName: normalizeName(body.commonName),
        scientificName: normalizeScientificName(body.scientificName),
        quantity: body.quantity === '' || body.quantity === undefined ? null : body.quantity,
        kingdom: normalizeName(body.kingdom),
        phylum: normalizeName(body.phylum),
        plantClass: normalizeName(body.plantClass),
        order: normalizeName(body.order),
        family: normalizeName(body.family),
        genus: normalizeName(body.genus),
        species: normalizeName(body.species),
        parts: {},
        uses: normalizeName(body.uses) || null,
        benefits: normalizeName(body.benefits) || null,
        harmful: normalizeName(body.harmful) || null
    };

    if (!clean.commonName) errors.push('commonName is required');
    if (!clean.scientificName) errors.push('scientificName is required');
    if (!body.typeId) errors.push('typeId is required');
    if (clean.quantity !== null && Number.isNaN(Number(clean.quantity))) {
        errors.push('quantity must be a number');
    }

    const parts = body.parts || {};
    for (const key of ['heightMinCm', 'heightMaxCm', 'widthMinCm', 'widthMaxCm']) {
        const raw = parts[key];
        if (raw !== undefined && raw !== null && raw !== '' && Number.isNaN(Number(raw))) {
            errors.push(`parts.${key} must be a number`);
        }
    }
    if (parts.heightMinCm != null && parts.heightMaxCm != null && Number(parts.heightMinCm) > Number(parts.heightMaxCm)) {
        errors.push('parts.heightMinCm cannot exceed heightMaxCm');
    }
    if (parts.widthMinCm != null && parts.widthMaxCm != null && Number(parts.widthMinCm) > Number(parts.widthMaxCm)) {
        errors.push('parts.widthMinCm cannot exceed widthMaxCm');
    }
    for (const key of PARTS_FIELDS) {
        clean.parts[key] = parts[key] === undefined ? null : parts[key];
    }

    // Public visibility requires an approved primary description, so a
    // names-only submission would be "Approved" in My Submissions and never
    // listed. Same rule validateContribution already applies.
    if (!hasAnyPartValue(clean.parts) && !clean.uses && !clean.benefits && !clean.harmful) {
        errors.push('A plant needs at least a description, some measurements, or one photo');
    }

    // Model-class match. While ml/model/main/classes.json is absent there is
    // nothing to check against, so the name is accepted as typed — the model is
    // still being trained and failing every submission would be worse than an
    // unverified name.
    const classes = loadModelClasses();
    if (classes && clean.scientificName) {
        const wanted = clean.scientificName.toLowerCase();
        const match = classes.find((c) => c.scientific.toLowerCase() === wanted);
        if (match) {
            // Rewrite to the class's exact casing so the join key is a real
            // model class, not a near-miss.
            clean.scientificName = match.scientific;
        } else {
            warnings.push(
                `"${clean.scientificName}" is not a model class, so scans will never link to it. ` +
                'The library may legitimately contain species the model does not know.'
            );
        }
    }

    return { errors, warnings, clean };
}

function validateContribution(body, imageCount) {
    const errors = [];
    const hasText = body.uses || body.benefits || body.harmful;
    const hasParts = body.parts && Object.values(body.parts).some((v) => v !== null && v !== undefined && v !== '');
    if (!hasText && !hasParts && imageCount === 0) {
        errors.push('A contribution needs at least a description, some measurements, or one photo');
    }
    return errors;
}

/**
 * Creates the plant_addition request; the draft stays in `payload` only.
 *
 * When the draft came from a claimed discovery report the payload carries
 * `discoveryRequestId`, and two things happen in the SAME transaction as the
 * insert: the claim is verified (so any botanist cannot attach a record to a
 * report another botanist is working on — the client hides the control with
 * "view only" but the client is not the authority), and the report's
 * recordRequestId is set, so a report can never point at a record that was not
 * created.
 */
async function createPlantAdditionRequest(accountId, draft) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const claimError = await assertDiscoveryClaim(conn, draft.discoveryRequestId, accountId);
        if (claimError) {
            await conn.rollback();
            return claimError;
        }
        const [typeRows] = await conn.query('SELECT typeId, typeName, label FROM plant_types WHERE typeId = ?', [draft.typeId]);
        if (typeRows.length === 0) {
            await conn.rollback();
            return { error: 'Unknown plant type', code: 400 };
        }
        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'payload', 'status'],
            [
                accountId,
                'plant_addition',
                JSON.stringify({ ...draft, typeName: typeRows[0].typeName, typeLabel: typeRows[0].label }),
                'pending'
            ]
        );
        if (draft.discoveryRequestId) {
            await linkDiscoveryRecord(conn, requestId, draft.discoveryRequestId);
        }
        await conn.commit();
        return { requestId };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** Stores uploaded files and creates the pending plant_contribution request. */
async function createPlantContributionRequest(accountId, plantId, draft, files) {
    const conn = await mysqlPool.getConnection();
    // The route's discardFiles() unlinks the pre-move path, which no longer
    // exists once a file has been renamed into place — so a mid-batch failure
    // would orphan files no query can ever reach. These are the real
    // destinations, tracked so the rollback can remove them.
    const movedPaths = [];
    try {
        await conn.beginTransaction();

        const claimError = await assertDiscoveryClaim(conn, draft.discoveryRequestId, accountId);
        if (claimError) {
            await conn.rollback();
            return claimError;
        }

        const [plantRows] = await conn.query('SELECT plantId FROM plants WHERE plantId = ? FOR UPDATE', [plantId]);
        if (plantRows.length === 0) {
            await conn.rollback();
            return { error: 'Plant not found', code: 404 };
        }

        const dir = path.join(settings.plantImages.storageDir, plantId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const imageIds = [];
        for (const file of files) {
            const ext = path.extname(file.originalname).toLowerCase();
            // Never reuse the client-supplied name on disk.
            const storedFilename = `${crypto.randomUUID()}${ext}`;
            const relativePath = path.join(plantId, storedFilename);
            const destination = path.join(settings.plantImages.storageDir, relativePath);
            fs.renameSync(file.path, destination);
            movedPaths.push(destination);
            imageIds.push(await insertRow(
                conn,
                'plant_images',
                ['plantId', 'accountId', 'originalFilename', 'storedFilename', 'storedPath', 'mimeType', 'size', 'status', 'isPrimary'],
                [plantId, accountId, file.originalname, storedFilename, relativePath, file.mimetype, file.size, 'pending', false]
            ));
        }

        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'targetPlantId', 'payload', 'status'],
            [accountId, 'plant_contribution', plantId, JSON.stringify({ ...draft, imageIds }), 'pending']
        );

        if (draft.discoveryRequestId) {
            await linkDiscoveryRecord(conn, requestId, draft.discoveryRequestId);
        }

        await conn.commit();
        return { requestId, imageIds };
    } catch (err) {
        await conn.rollback();
        for (const destination of movedPaths) {
            try {
                if (fs.existsSync(destination)) fs.unlinkSync(destination);
            } catch (cleanupErr) {
                console.error('Could not remove rolled-back upload:', destination, cleanupErr.message);
            }
        }
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * The caller's own plant submissions and where each one stands.
 *
 * EXCLUDES plant_discovery on purpose. This selects WHERE ar.accountId = ? across
 * every request type, and lets a botanist file reports — so their own
 * reports would surface here, contradicting the plan's own validation and
 * breaking the existing submissions-status whitelist (which covers only
 * pending/approved/denied) the moment a report reached cancelled or rejected.
 *
 * An INCLUSION LIST, in BOTH queries, rather than `!= 'plant_discovery'`: it
 * fails closed, so a request type added later does not appear in a user's
 * submissions until someone remembers this line. It also mirrors
 * listPlantRequests, which hardcodes its own two-type list. The COUNT is the
 * easy one to forget, and omitting it leaves the pagination total counting rows
 * the page never shows.
 *
 * A botanist's own reports stay reachable through GET /api/discoveries/mine,
 * which is accountId-scoped and is where report states belong.
 */
async function listMyRequests(accountId, { page, pageSize } = {}) {
    const paging = parsePaging({ page, pageSize });
    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.requestType, ar.status, ar.targetPlantId, ar.note,
                ar.payload, ar.createdAt, ar.reviewedAt,
                ar.reviewedBy, ar.approvalMode,
                p.commonName AS targetCommonName,
                rev.username AS reviewerName,
                CONCAT_WS(' ', revp.firstName, revp.lastName) AS reviewerLabel
         FROM approval_requests ar
         LEFT JOIN plants p ON ar.targetPlantId = p.plantId
         LEFT JOIN accounts rev ON ar.reviewedBy = rev.accountId
         LEFT JOIN profiles revp ON revp.accountId = rev.accountId
         WHERE ar.accountId = ?
           AND ar.requestType IN ('plant_addition','plant_contribution')
         ORDER BY ar.createdAt DESC
         LIMIT ? OFFSET ?`,
        [accountId, paging.pageSize, paging.offset]
    );
    const [countRows] = await mysqlPool.query(
        "SELECT COUNT(*) AS total FROM approval_requests WHERE accountId = ? " +
        "AND requestType IN ('plant_addition','plant_contribution')",
        [accountId]
    );

    // Only a plant_contribution ever carries imageIds; a plant_addition has none
    // by design, because its photos are submitted later as a separate
    // contribution and appear on that row. The ids in payload are not trusted —
    // this read is scoped to the caller's own accountIds, and the owner route
    // re-checks them.
    const imageIdsByRequest = new Map();
    const allImageIds = new Set();
    for (const r of rows) {
        const payload = parsePayload(r.payload);
        const ids = Array.isArray(payload.imageIds)
            ? payload.imageIds.filter((id) => typeof id === 'string' && id.length > 0)
            : [];
        imageIdsByRequest.set(r.requestId, ids);
        ids.forEach((id) => allImageIds.add(id));
    }

    const imageById = new Map();
    if (allImageIds.size > 0) {
        const placeholders = [...allImageIds].map(() => '?').join(',');
        const [imgRows] = await mysqlPool.query(
            `SELECT imageId, status, mimeType, size, originalFilename
             FROM plant_images WHERE accountId = ? AND imageId IN (${placeholders})`,
            [accountId, ...allImageIds]
        );
        for (const img of imgRows) imageById.set(img.imageId, img);
    }

    return {
        requests: rows.map((r) => {
            const payload = parsePayload(r.payload);
            return {
                id: r.requestId,
                requestType: r.requestType,
                status: r.status,
                targetPlantId: r.targetPlantId,
                targetPlantName: r.targetCommonName,
                note: r.note,
                createdAt: r.createdAt,
                reviewedAt: r.reviewedAt,
                reviewerName: r.reviewerName,
                // The human-readable reviewer. `reviewerName` is the username, which
                // for an automatic approval would read "system" in lower case while
                // every other page says "System" — so the submission list uses the
                // profile label, the same join the public plant page uses.
                reviewerLabel: r.reviewerLabel || r.reviewerName,
                // Lets the submissions list say AUTO instead of naming a person.
                approvalMode: r.approvalMode || 'manual',
                // The report this record was made from, when there was one. The
                // client renders the line only when the field is present, so a
                // submission with no report is unchanged.
                discoveryRequestId: payload.discoveryRequestId || null,
            // The owner route, never the public one: a pending photo must not
            // become a public, cacheable response.
            images: (imageIdsByRequest.get(r.requestId) || [])
                .map((imageId) => {
                    const img = imageById.get(imageId);
                    if (!img) return null;
                    return {
                        imageId: img.imageId,
                        url: `/api/plants/mine/images/${encodeURIComponent(img.imageId)}`,
                        status: img.status,
                        mimeType: img.mimeType,
                        size: img.size,
                        originalFilename: img.originalFilename
                    };
                })
                .filter(Boolean)
            };
        }),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize
    };
}

module.exports = {
    validatePlantDraft,
    validateContribution,
    createPlantAdditionRequest,
    createPlantContributionRequest,
    listMyRequests
};
