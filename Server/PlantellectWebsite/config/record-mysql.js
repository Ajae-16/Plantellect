// Botanist submissions.
// Split out of mysql.js; see mysql.js for the combined export list.

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const settings = require('./settings');
const { insertRow } = require('./ids.js');
const { mysqlPool } = require('./pool-mysql');
const { normalizeName, normalizeRichText, normalizeScientificName, PARTS_FIELDS, hasAnyPartValue, loadModelClasses, parsePaging, parsePayload, TAXONOMY_LEVELS, UNSPECIFIED_TAXONOMY, normalizeTypeSpec } = require('./shared-mysql');
const { assertDiscoveryClaim, linkDiscoveryRecord, DISCOVERY_STORAGE_ROOT } = require('./discovery-mysql');
const imageFiles = require('./image-files');

/**
 * Validates a new-plant draft. Returns { errors, warnings, clean }.
 * The caller must store `clean`, not the raw body.
 */
function validatePlantDraft(body) {
    const errors = [];
    const warnings = [];

    const clean = {
        commonName: normalizeName(body.commonName),
        scientificName: normalizeScientificName(body.scientificName),
        kingdom: normalizeName(body.kingdom),
        phylum: normalizeName(body.phylum),
        plantClass: normalizeName(body.plantClass),
        order: normalizeName(body.order),
        family: normalizeName(body.family),
        genus: normalizeName(body.genus),
        species: normalizeName(body.species),
        parts: {},
        uses: normalizeRichText(body.uses) || null,
        benefits: normalizeRichText(body.benefits) || null,
        harmful: normalizeRichText(body.harmful) || null
    };

    if (!clean.commonName) errors.push('commonName is required');
    if (!clean.scientificName) errors.push('scientificName is required');
    // The plant's own type: free text name, flags, toxicity level, caution note. Only
    // a SPEC here; the plant_types row is created when an admin approves, so a
    // rejected request never leaves a stray row behind.
    const typeCheck = normalizeTypeSpec(body);
    errors.push(...typeCheck.errors);
    clean.typeSpec = typeCheck.spec;

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

    if (!hasAnyPartValue(clean.parts) && !clean.uses && !clean.benefits && !clean.harmful) {
        errors.push('A plant needs a description or some measurements — photos alone are never published');
    }

    const classes = loadModelClasses();
    if (classes && clean.scientificName) {
        const wanted = clean.scientificName.toLowerCase();
        const match = classes.find((c) => c.scientific.toLowerCase() === wanted);
        if (match) {
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

// ---------------------------------------------------------------------------
// Shared pieces of a submission
// ---------------------------------------------------------------------------

function isSafeType(type) {
    return Boolean(type) && !type.isHarmful && (type.toxicityLevel || 'none') === 'none';
}

function draftHasContent(draft) {
    return Boolean(draft.uses || draft.benefits || draft.harmful || hasAnyPartValue(draft.parts || {}));
}

/** A failure the submitter can act on, thrown from inside a transaction. */
function userError(message, code) {
    const err = new Error(message);
    err.userFacing = true;
    err.code = code;
    return err;
}

/**
 * Resolves the discovery-report photos a botanist chose to attach to a record.
 * Attaching is a COPY; every id must belong to the claimed report.
 */
async function loadDiscoveryPhotos(conn, discoveryRequestId, ids) {
    const unique = [...new Set((ids || []).filter((id) => typeof id === 'string' && id))];
    if (unique.length === 0) return [];
    if (!discoveryRequestId) {
        throw userError('Report photos can only be attached to a record made from a discovery report', 400);
    }
    const [rows] = await conn.query(
        `SELECT imageId, originalFilename, storedPath, mimeType, size
         FROM discovery_images
         WHERE requestId = ? AND imageId IN (${unique.map(() => '?').join(',')})`,
        [discoveryRequestId, ...unique]
    );
    if (rows.length !== unique.length) {
        throw userError('One of the chosen report photos does not belong to that report', 400);
    }
    return rows;
}

/**
 * Files uploaded photos and chosen report photos into the plant-image store,
 * inserting one PENDING plant_images row for each. Everything lands in
 * plants/pending/<requestId>/ (the folder is the request's, because a brand-new
 * species has no plantId yet).
 *
 * COPY, verify, then delete the source (see image-files.js). The upload's temp
 * file is deleted by plan.finalize() after the commit; a report photo is copied
 * and its original stays with the report. If a photo cannot be copied cleanly
 * after the retry limit the whole submission fails with a message the botanist
 * can act on: nothing has been approved yet, so there is no admin to tell.
 */
async function stageImages(conn, { accountId, plantId, requestId, files, photos, plan }) {
    const storageDir = settings.plantImages.storageDir;
    const relativeDir = imageFiles.plantRelativeDir('pending', requestId);
    const dir = path.join(storageDir, relativeDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const columns = ['plantId', 'accountId', 'originalFilename', 'storedFilename', 'storedPath', 'mimeType', 'size', 'status', 'isPrimary'];
    const imageIds = [];

    const failed = (name, result) => userError(
        `The photo "${name}" could not be saved cleanly after ${result.attempts || 1} attempts (${result.error}). ` +
            'Nothing was submitted. Please try again, or use a different copy of the photo.',
        500
    );

    for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        const storedFilename = `${crypto.randomUUID()}${ext}`;
        const relativePath = path.join(relativeDir, storedFilename);
        const destination = path.join(storageDir, relativePath);
        const copied = await plan.stage(file.path, destination, { mimeType: file.mimetype });
        if (!copied.ok) throw failed(file.originalname, copied);
        imageIds.push(await insertRow(
            conn, 'plant_images', columns,
            [plantId || null, accountId, file.originalname, storedFilename, relativePath, file.mimetype, file.size, 'pending', false]
        ));
    }

    const discoveryRoot = path.resolve(DISCOVERY_STORAGE_ROOT);
    for (const photo of photos) {
        const source = path.resolve(path.join(DISCOVERY_STORAGE_ROOT, photo.storedPath));
        if (!source.startsWith(discoveryRoot + path.sep) || !fs.existsSync(source)) {
            throw userError('A report photo is no longer on the server, so it could not be attached', 409);
        }
        const ext = path.extname(photo.storedPath).toLowerCase();
        const storedFilename = `${crypto.randomUUID()}${ext}`;
        const relativePath = path.join(relativeDir, storedFilename);
        const destination = path.join(storageDir, relativePath);
        // deleteSource: false. The report keeps its own photo.
        const copied = await plan.stage(source, destination, { mimeType: photo.mimeType, deleteSource: false });
        if (!copied.ok) throw failed(photo.originalFilename, copied);
        imageIds.push(await insertRow(
            conn, 'plant_images', columns,
            [plantId || null, accountId, photo.originalFilename, storedFilename, relativePath, photo.mimeType, photo.size, 'pending', false]
        ));
    }

    return imageIds;
}

// ---------------------------------------------------------------------------
// Creating requests
// ---------------------------------------------------------------------------

/**
 * Creates the plant_addition request, with its photos.
 * A species already in the library is refused with the existing plantId.
 */
async function createPlantAdditionRequest(accountId, draft, files = [], discoveryImageIds = []) {
    const conn = await mysqlPool.getConnection();
    const plan = new imageFiles.FileMovePlan();
    try {
        await conn.beginTransaction();
        const claimError = await assertDiscoveryClaim(conn, draft.discoveryRequestId, accountId);
        if (claimError) {
            await conn.rollback();
            return claimError;
        }

        /*
         * ARCHIVE-OFF:
         * The archivedAt column and archived-plant check are disabled.
         *
         * Original query:
         * SELECT plantId, commonName, archivedAt
         * FROM plants
         * WHERE scientificName = ?
         */
        const [existing] = await conn.query(
            'SELECT plantId, commonName FROM plants WHERE scientificName = ?',
            [draft.scientificName]
        );

        if (existing.length > 0) {
            await conn.rollback();

            /*
             * ARCHIVE-OFF:
             * if (existing[0].archivedAt) {
             *     return {
             *         error: `"${draft.scientificName}" exists as ${existing[0].commonName} but is archived. ` +
             *             'Ask an admin to restore it instead of recording it again.',
             *         code: 409
             *     };
             * }
             */

            return {
                error: `"${draft.scientificName}" is already in the library as ${existing[0].commonName}. ` +
                    'Add to that plant instead of recording it again.',
                code: 409,
                existingPlantId: existing[0].plantId
            };
        }

        const payloadDraft = { ...draft };
        delete payloadDraft.quantity;
        let strippedHarmful = false;
        const spec = draft.typeSpec;
        if (isSafeType(spec) && payloadDraft.harmful) {
            payloadDraft.harmful = null;
            strippedHarmful = true;
        }
        if (!draftHasContent(payloadDraft)) {
            await conn.rollback();
            return {
                error: 'A plant needs a description or some measurements. ' +
                    'This type is marked safe, so a caution on its own does not count.',
                code: 400
            };
        }

        const photos = await loadDiscoveryPhotos(conn, draft.discoveryRequestId, discoveryImageIds);

        const basePayload = { ...payloadDraft, typeName: spec.typeName, typeLabel: spec.typeName, imageIds: [] };
        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'payload', 'status'],
            [accountId, 'plant_addition', JSON.stringify(basePayload), 'pending']
        );

        const imageIds = await stageImages(conn, {
            accountId,
            plantId: null,
            requestId,
            files,
            photos,
            plan
        });
        if (imageIds.length > 0) {
            await conn.query(
                'UPDATE approval_requests SET payload = ? WHERE requestId = ?',
                [JSON.stringify({ ...basePayload, imageIds }), requestId]
            );
        }

        if (draft.discoveryRequestId) {
            await linkDiscoveryRecord(conn, requestId, draft.discoveryRequestId);
        }
        await conn.commit();
        // The copies are verified and the rows point at them: now the temp
        // uploads can go.
        await plan.finalize();
        return { requestId, imageIds, strippedHarmful };
    } catch (err) {
        await conn.rollback().catch(() => {});
        await plan.rollback();
        if (err && err.userFacing) return { error: err.message, code: err.code };
        throw err;
    } finally {
        conn.release();
    }
}

/** Stores uploaded files and creates the pending plant_contribution request. */
async function createPlantContributionRequest(accountId, plantId, draft, files, discoveryImageIds = []) {
    const conn = await mysqlPool.getConnection();
    const plan = new imageFiles.FileMovePlan();
    try {
        await conn.beginTransaction();

        const claimError = await assertDiscoveryClaim(conn, draft.discoveryRequestId, accountId);
        if (claimError) {
            await conn.rollback();
            return claimError;
        }

        /*
         * ARCHIVE-OFF:
         * The archivedAt filter is disabled until that column exists.
         *
         * Original condition:
         * WHERE p.plantId = ? AND p.archivedAt IS NULL FOR UPDATE OF p
         */
        const [plantRows] = await conn.query(
            `SELECT p.plantId, t.isHarmful, t.toxicityLevel
             FROM plants p JOIN plant_types t ON p.typeId = t.typeId
             WHERE p.plantId = ? FOR UPDATE OF p`,
            [plantId]
        );
        if (plantRows.length === 0) {
            await conn.rollback();
            return { error: 'Plant not found', code: 404 };
        }

        const payloadDraft = { ...draft };
        let strippedHarmful = false;
        if (isSafeType(plantRows[0]) && payloadDraft.harmful) {
            payloadDraft.harmful = null;
            strippedHarmful = true;
        }

        const photos = await loadDiscoveryPhotos(conn, draft.discoveryRequestId, discoveryImageIds);
        if (!draftHasContent(payloadDraft) && files.length + photos.length === 0) {
            await conn.rollback();
            return { error: 'A contribution needs at least a description, some measurements, or one photo', code: 400 };
        }

        // The request row comes first now: the photos are filed under
        // plants/pending/<requestId>/, so the id has to exist before they do
        // (same order as createPlantAdditionRequest).
        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'targetPlantId', 'payload', 'status'],
            [accountId, 'plant_contribution', plantId, JSON.stringify({ ...payloadDraft, imageIds: [] }), 'pending']
        );

        const imageIds = await stageImages(conn, {
            accountId,
            plantId,
            requestId,
            files,
            photos,
            plan
        });
        if (imageIds.length > 0) {
            await conn.query(
                'UPDATE approval_requests SET payload = ? WHERE requestId = ?',
                [JSON.stringify({ ...payloadDraft, imageIds }), requestId]
            );
        }

        if (draft.discoveryRequestId) {
            await linkDiscoveryRecord(conn, requestId, draft.discoveryRequestId);
        }

        await conn.commit();
        await plan.finalize();
        return { requestId, imageIds, strippedHarmful };
    } catch (err) {
        await conn.rollback().catch(() => {});
        await plan.rollback();
        if (err && err.userFacing) return { error: err.message, code: err.code };
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * A request to change the taxonomy of a plant that already has one.
 * One pending request per plant.
 */
async function createPlantTaxonomyRequest(accountId, plantId, body) {
    const errors = [];
    const proposed = {};
    for (const level of TAXONOMY_LEVELS) {
        const raw = level === 'class' ? (body.plantClass ?? body.class) : body[level];
        const value = normalizeName(raw);
        if (!value) continue;
        if (value.length > 100) {
            errors.push(`${level} is longer than 100 characters`);
            continue;
        }
        if (value.toLowerCase() === UNSPECIFIED_TAXONOMY.toLowerCase()) {
            errors.push(`${level}: "${UNSPECIFIED_TAXONOMY}" marks a gap and cannot be proposed as a value`);
            continue;
        }
        proposed[level] = value;
    }
    const reason = normalizeName(body.reason).slice(0, 500) || null;
    if (errors.length > 0) return { error: errors.join('; '), code: 400 };
    if (Object.keys(proposed).length === 0) {
        return { error: 'Enter at least one taxonomy level to change', code: 400 };
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        /*
         * ARCHIVE-OFF:
         * The archivedAt filter is disabled until that column exists.
         *
         * Original condition:
         * WHERE p.plantId = ? AND p.archivedAt IS NULL FOR UPDATE OF p
         */
        const [rows] = await conn.query(
            `SELECT p.plantId, tx.\`kingdom\`, tx.\`phylum\`, tx.\`class\`, tx.\`order\`, tx.\`family\`, tx.\`genus\`, tx.\`species\`
             FROM plants p JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
             WHERE p.plantId = ? FOR UPDATE OF p`,
            [plantId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Plant not found', code: 404 };
        }

        const changes = {};
        for (const [level, to] of Object.entries(proposed)) {
            if (rows[0][level] !== to) changes[level] = { from: rows[0][level], to };
        }
        if (Object.keys(changes).length === 0) {
            await conn.rollback();
            return { error: 'That is what the plant already records, so there is nothing to change', code: 400 };
        }

        const [pending] = await conn.query(
            `SELECT requestId FROM approval_requests
             WHERE requestType = 'plant_taxonomy' AND targetPlantId = ? AND status = 'pending' LIMIT 1`,
            [plantId]
        );
        if (pending.length > 0) {
            await conn.rollback();
            return {
                error: `A taxonomy update for this plant is already waiting for review (${pending[0].requestId}).`,
                code: 409
            };
        }

        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'targetPlantId', 'payload', 'status'],
            [accountId, 'plant_taxonomy', plantId, JSON.stringify({ changes, reason }), 'pending']
        );
        await conn.commit();
        return { requestId, changes };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Recording lookups
// ---------------------------------------------------------------------------

/**
 * One plant as the record form needs it, found by plantId or by scientific name.
 * Botanist-only at the route. (This query never touched archivedAt.)
 */
async function getRecordingPlant({ plantId, scientificName }) {
    const where = plantId ? 'p.plantId = ?' : 'p.scientificName = ?';
    const key = plantId || normalizeScientificName(scientificName);
    if (!key) return null;

    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.typeId,
                t.typeName, t.typeName AS typeLabel, t.isHarmful, t.toxicityLevel,
                tx.\`kingdom\`, tx.\`phylum\`, tx.\`class\`, tx.\`order\`, tx.\`family\`, tx.\`genus\`, tx.\`species\`,
                (SELECT COUNT(*) FROM approval_requests ar
                 WHERE ar.targetPlantId = p.plantId AND ar.requestType = 'plant_taxonomy' AND ar.status = 'pending') AS pendingTaxonomy
         FROM plants p
         JOIN plant_types t ON t.typeId = p.typeId
         JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
         WHERE ${where}`,
        [key]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const taxonomy = {};
    for (const level of TAXONOMY_LEVELS) taxonomy[level] = r[level];
    return {
        id: r.plantId,
        name: r.commonName,
        scientificName: r.scientificName,
        typeId: r.typeId,
        type: r.typeName,
        typeLabel: r.typeLabel,
        isSafeType: isSafeType(r),
        taxonomy,
        unspecifiedLevels: TAXONOMY_LEVELS.filter((level) => r[level] === UNSPECIFIED_TAXONOMY),
        hasPendingTaxonomyRequest: Number(r.pendingTaxonomy) > 0
    };
}

/**
 * The caller's own plant submissions and where each one stands.
 * An INCLUSION list in both queries: it fails closed.
 */
const MY_REQUEST_TYPES = "('plant_addition','plant_contribution','plant_taxonomy','plant_change')";

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
           AND ar.requestType IN ${MY_REQUEST_TYPES}
         ORDER BY ar.createdAt DESC
         LIMIT ? OFFSET ?`,
        [accountId, paging.pageSize, paging.offset]
    );
    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total FROM approval_requests WHERE accountId = ? AND requestType IN ${MY_REQUEST_TYPES}`,
        [accountId]
    );

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
                targetPlantName: r.targetCommonName || (r.requestType === 'plant_addition' ? (payload.commonName || null) : null),
                taxonomyChanges: r.requestType === 'plant_taxonomy' ? (payload.changes || {}) : null,
                changes: r.requestType === 'plant_change' ? (payload.changes || {}) : null,
                changeReason: r.requestType === 'plant_change' ? (payload.reason || null) : null,
                changeScope: r.requestType === 'plant_change' ? (payload.scope || 'legacy') : null,
                changeDescriptionId: r.requestType === 'plant_change' ? (payload.descriptionId || null) : null,
                note: r.note,
                createdAt: r.createdAt,
                reviewedAt: r.reviewedAt,
                reviewerName: r.reviewerName,
                reviewerLabel: r.reviewerLabel || r.reviewerName,
                approvalMode: r.approvalMode || 'manual',
                discoveryRequestId: payload.discoveryRequestId || null,
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
    createPlantTaxonomyRequest,
    getRecordingPlant,
    isSafeType,
    listMyRequests
};