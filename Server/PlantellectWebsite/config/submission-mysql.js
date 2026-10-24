// Botanist submissions.
// Split out of mysql.js; see mysql.js for the combined export list.

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const settings = require('./settings');
const { insertRow } = require('./ids.js');
const { mysqlPool } = require('./pool-mysql');
const { normalizeName, normalizeScientificName, PARTS_FIELDS, hasAnyPartValue, loadModelClasses, parsePaging, parsePayload, TAXONOMY_LEVELS, UNSPECIFIED_TAXONOMY } = require('./shared-mysql');
const { assertDiscoveryClaim, linkDiscoveryRecord, DISCOVERY_STORAGE_ROOT } = require('./discovery-mysql');

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
        errors.push('A plant needs a description or some measurements — photos alone are never published');
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

// ---------------------------------------------------------------------------
// Shared pieces of a submission
// ---------------------------------------------------------------------------

/**
 * A plant type is "safe" when plant_types itself flags nothing: not harmful, and
 * a toxicity level of 'none'. The decision comes from the table, never from the
 * plant's name. Used on the SERVER as well as in the form, because the form
 * hiding the Harmful / caution box is a courtesy and not the authority: a
 * crafted request must not be able to attach a warning to a plant its own type
 * says has none.
 */
function isSafeType(type) {
    return Boolean(type) && !type.isHarmful && (type.toxicityLevel || 'none') === 'none';
}

function draftHasContent(draft) {
    return Boolean(draft.uses || draft.benefits || draft.harmful || hasAnyPartValue(draft.parts || {}));
}

function removeFiles(paths) {
    for (const target of paths) {
        try {
            if (fs.existsSync(target)) fs.unlinkSync(target);
        } catch (cleanupErr) {
            console.error('Could not remove rolled-back upload:', target, cleanupErr.message);
        }
    }
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
 *
 * Attaching is a COPY: the report's own file stays where it is, as evidence, and
 * the copy enters plant_images as a PENDING row, so the admin decides on it like
 * any other photo. That is the whole point of the option — the report photo never
 * becomes a library image on the strength of the report alone. Every id must
 * belong to the claimed report; one that does not fails the submission instead
 * of being silently dropped.
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
 * Moves uploaded files and copies chosen report photos into the plant-image
 * store, inserting one PENDING plant_images row for each.
 *
 * `plantId` is null for a brand-new species: the plant does not exist until an
 * admin approves it, so those rows carry no plantId and are given one at
 * approval (approvePlantRequest). `relativeDir` is therefore a staging folder
 * for them. A row with no plantId is invisible to every plantId-keyed query —
 * the public library, the training-set export — and only the owner route and
 * the admin review route read it by imageId.
 *
 * Every destination is pushed to `movedPaths` so the caller's rollback can
 * remove it; the route's own discardFiles only knows the pre-move paths.
 */
async function stageImages(conn, { accountId, plantId, relativeDir, files, photos, movedPaths }) {
    const storageDir = settings.plantImages.storageDir;
    const dir = path.join(storageDir, relativeDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const columns = ['plantId', 'accountId', 'originalFilename', 'storedFilename', 'storedPath', 'mimeType', 'size', 'status', 'isPrimary'];
    const imageIds = [];

    for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        // Never reuse the client-supplied name on disk.
        const storedFilename = `${crypto.randomUUID()}${ext}`;
        const relativePath = path.join(relativeDir, storedFilename);
        const destination = path.join(storageDir, relativePath);
        fs.renameSync(file.path, destination);
        movedPaths.push(destination);
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
        fs.copyFileSync(source, destination);
        movedPaths.push(destination);
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
 *
 * Photos now travel WITH the new species, so the admin sees the evidence while
 * deciding on the plant instead of approving text and waiting days for a second
 * submission. They are stored pending and attach to the plant when it is created.
 *
 * A species that is already in the library is refused here with the existing
 * plantId, so the client can turn the submission into a contribution. This
 * replaces "accept it and convert at approval": that conversion is still the
 * backstop for two botanists racing on a species neither could see, but it must
 * not be the normal path, because a duplicate request carries its own taxonomy
 * and its own plant row that nobody can use.
 *
 * An ARCHIVED plant still counts as existing (its scientific name is taken), but
 * the botanist is told to ask an admin to restore it rather than to add to it,
 * because contributions to an archived plant are refused.
 *
 * When the draft came from a claimed discovery report the payload carries
 * `discoveryRequestId`, and the claim is verified in the SAME transaction as the
 * insert — the client's "view only" state is not the authority.
 */
async function createPlantAdditionRequest(accountId, draft, files = [], discoveryImageIds = []) {
    const conn = await mysqlPool.getConnection();
    const movedPaths = [];
    try {
        await conn.beginTransaction();
        const claimError = await assertDiscoveryClaim(conn, draft.discoveryRequestId, accountId);
        if (claimError) {
            await conn.rollback();
            return claimError;
        }

        const [typeRows] = await conn.query(
            'SELECT typeId, typeName, label, isHarmful, toxicityLevel FROM plant_types WHERE typeId = ?',
            [draft.typeId]
        );
        if (typeRows.length === 0) {
            await conn.rollback();
            return { error: 'Unknown plant type', code: 400 };
        }

        const [existing] = await conn.query(
            'SELECT plantId, commonName, archivedAt FROM plants WHERE scientificName = ?',
            [draft.scientificName]
        );
        if (existing.length > 0) {
            await conn.rollback();
            if (existing[0].archivedAt) {
                return {
                    error: `"${draft.scientificName}" exists as ${existing[0].commonName} but is archived. ` +
                        'Ask an admin to restore it instead of recording it again.',
                    code: 409
                };
            }
            return {
                error: `"${draft.scientificName}" is already in the library as ${existing[0].commonName}. ` +
                    'Add to that plant instead of recording it again.',
                code: 409,
                existingPlantId: existing[0].plantId
            };
        }

        const payloadDraft = { ...draft };
        delete payloadDraft.quantity;   // derived from approved photos now, never typed
        let strippedHarmful = false;
        if (isSafeType(typeRows[0]) && payloadDraft.harmful) {
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

        const basePayload = { ...payloadDraft, typeName: typeRows[0].typeName, typeLabel: typeRows[0].label, imageIds: [] };
        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'payload', 'status'],
            [accountId, 'plant_addition', JSON.stringify(basePayload), 'pending']
        );

        const imageIds = await stageImages(conn, {
            accountId,
            plantId: null,
            relativeDir: path.join('pending', requestId),
            files,
            photos,
            movedPaths
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
        return { requestId, imageIds, strippedHarmful };
    } catch (err) {
        await conn.rollback().catch(() => {});
        removeFiles(movedPaths);
        if (err && err.userFacing) return { error: err.message, code: err.code };
        throw err;
    } finally {
        conn.release();
    }
}

/** Stores uploaded files and creates the pending plant_contribution request. */
async function createPlantContributionRequest(accountId, plantId, draft, files, discoveryImageIds = []) {
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

        // An archived plant is out of the library: nothing can be added to it.
        const [plantRows] = await conn.query(
            `SELECT p.plantId, t.isHarmful, t.toxicityLevel
             FROM plants p JOIN plant_types t ON p.typeId = t.typeId
             WHERE p.plantId = ? AND p.archivedAt IS NULL FOR UPDATE OF p`,
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

        const imageIds = await stageImages(conn, {
            accountId,
            plantId,
            relativeDir: plantId,
            files,
            photos,
            movedPaths
        });

        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'targetPlantId', 'payload', 'status'],
            [accountId, 'plant_contribution', plantId, JSON.stringify({ ...payloadDraft, imageIds }), 'pending']
        );

        if (draft.discoveryRequestId) {
            await linkDiscoveryRecord(conn, requestId, draft.discoveryRequestId);
        }

        await conn.commit();
        return { requestId, imageIds, strippedHarmful };
    } catch (err) {
        await conn.rollback().catch(() => {});
        removeFiles(movedPaths);
        if (err && err.userFacing) return { error: err.message, code: err.code };
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * A request to change the taxonomy of a plant that already has one.
 *
 * Taxonomy belongs to the PLANT: plants.taxonomyId is a foreign key, and a
 * description or photo contribution never carries taxonomy at all. So the only
 * way to change it is this request, which is separate from every description and
 * image submission on purpose — a taxonomy disagreement must not hold up a good
 * photo, and a good photo must not smuggle a taxonomy change through.
 *
 * Only the levels that DIFFER are stored, each with the value it was compared
 * against, so the admin reviews a diff and approval can refuse a stale one. A
 * blank field means "no change", never "clear this level", and the Unspecified
 * sentinel cannot be proposed: it is the gap marker, not a value.
 *
 * One pending request per plant. That is what stops two botanists filing rival
 * taxonomies for the same species and leaving the admin to pick between them by
 * submission order.
 */
async function createPlantTaxonomyRequest(accountId, plantId, body) {
    const errors = [];
    const proposed = {};
    for (const level of TAXONOMY_LEVELS) {
        // The form and the new-plant payload call this level plantClass; the column is `class`.
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

        const [rows] = await conn.query(
            `SELECT p.plantId, tx.\`kingdom\`, tx.\`phylum\`, tx.\`class\`, tx.\`order\`, tx.\`family\`, tx.\`genus\`, tx.\`species\`
             FROM plants p JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
             WHERE p.plantId = ? AND p.archivedAt IS NULL FOR UPDATE OF p`,
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
 *
 * This is NOT the public detail read. That one hides a plant until it has an
 * approved description, and "does this species already exist?" has to be
 * answered for a plant that has none yet — otherwise the form would let a
 * botanist record, as new, a species that is sitting in the database unpublished.
 * Botanist-only at the route.
 *
 * Returns the type's safety flags (so the form can hide Harmful / caution), the
 * current taxonomy (shown read-only), and whether a taxonomy update is already
 * waiting (so the form does not offer a second one).
 */
async function getRecordingPlant({ plantId, scientificName }) {
    const where = plantId ? 'p.plantId = ?' : 'p.scientificName = ?';
    const key = plantId || normalizeScientificName(scientificName);
    if (!key) return null;

    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.typeId,
                t.typeName, t.label AS typeLabel, t.isHarmful, t.toxicityLevel,
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
 * listPlantRequests, which hardcodes its own list. The COUNT is the
 * easy one to forget, and omitting it leaves the pagination total counting rows
 * the page never shows.
 *
 * A botanist's own reports stay reachable through GET /api/discoveries/mine,
 * which is accountId-scoped and is where report states belong.
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

    // A plant_contribution and a plant_addition both carry imageIds now (a new
    // species is submitted with its photos). The ids in payload are not trusted —
    // this read is scoped to the caller's own accountId, and the owner route
    // re-checks them. A pending photo of a new species has no plantId yet, which
    // is why the lookup is by accountId + imageId and never by plant.
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
                // Only a taxonomy request has this: the levels it asks to change.
                taxonomyChanges: r.requestType === 'plant_taxonomy' ? (payload.changes || {}) : null,
                // Only a change request has these: field -> { from, to }, and why.
                changes: r.requestType === 'plant_change' ? (payload.changes || {}) : null,
                changeReason: r.requestType === 'plant_change' ? (payload.reason || null) : null,
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
    createPlantTaxonomyRequest,
    getRecordingPlant,
    isSafeType,
    listMyRequests
};