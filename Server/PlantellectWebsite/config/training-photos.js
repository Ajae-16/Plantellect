// Training status of approved photos (dataset handler).
//
// Four separate things live on a photo (plan section 6): status (review), publicVisible (public
// copies), archivedAt (archive) and trainingStatus (does it feed a training snapshot). This file only
// touches the last one and the two organising fields that go with it:
//
//   trainingStatus   candidate (the default) | included | excluded, with trainingReason
//   part             Leaves, Leaves with stem, Whole plant, ...  Organisation and reporting only,
//                    NEVER a label: the model predicts species.
//   groupKey         photos of one plant that must always land in the same split (train, val or test)
//
// Hiding or archiving a photo does not change its training status, and the other way round: they
// are separate buttons on purpose. Only an APPROVED photo whose master still exists can be given a
// training status; a denied or pending photo never reaches a snapshot.
//
// The database is injected (`deps`) so the rules can be tested without MySQL. Callers pass nothing.

const settings = require('./settings');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = ['candidate', 'included', 'excluded'];
const GROUP_KEY = /^[\p{L}\p{N}][\p{L}\p{N} ._:-]*$/u;

const fail = (error, code = 400, extra = {}) => ({ error, code, ...extra });

function resolveDeps(deps = {}) {
    return { db: deps.db || require('./pool-mysql').mysqlPool };
}

/** 'whole  plant' -> 'Whole plant'. Same rule as the ML side (first character only). */
function normalizeName(name) {
    const s = String(name).split(/\s+/).filter(Boolean).join(' ');
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const sameName = (a, b) => normalizeName(a).toLowerCase() === normalizeName(b).toLowerCase();

/**
 * Checks and cleans one change. Returns { patch } or { error, code }. Only the keys that were
 * sent are changed; null or '' clears part, groupKey and trainingReason.
 */
function validatePatch(input, allowedParts = settings.dataset.parts) {
    if (!input || typeof input !== 'object') return fail('Nothing to change');
    const patch = {};

    if (input.trainingStatus !== undefined) {
        if (!STATUSES.includes(input.trainingStatus)) {
            return fail(`The training status must be one of: ${STATUSES.join(', ')}`);
        }
        patch.trainingStatus = input.trainingStatus;
    }

    if (input.trainingReason !== undefined) {
        if (input.trainingReason !== null && typeof input.trainingReason !== 'string') return fail('The reason must be text');
        const reason = (input.trainingReason || '').trim();
        if (reason.length > settings.dataset.reasonMaxLength) {
            return fail(`The reason can be at most ${settings.dataset.reasonMaxLength} characters`);
        }
        patch.trainingReason = reason || null;
    } else if (patch.trainingStatus && patch.trainingStatus !== 'excluded') {
        // Moving a photo back to candidate or included drops a reason that only made sense for "excluded".
        patch.trainingReason = null;
    }

    if (input.part !== undefined) {
        if (input.part !== null && typeof input.part !== 'string') return fail('The part must be text');
        const raw = (input.part || '').trim();
        if (!raw) {
            patch.part = null;
        } else {
            const match = allowedParts.find((p) => sameName(p, raw));
            if (!match) return fail(`"${raw.slice(0, 40)}" is not in the part list (${allowedParts.join(', ')})`);
            patch.part = match;
        }
    }

    if (input.groupKey !== undefined) {
        if (input.groupKey !== null && typeof input.groupKey !== 'string') return fail('The group must be text');
        const raw = (input.groupKey || '').split(/\s+/).filter(Boolean).join(' ');
        if (!raw) {
            patch.groupKey = null;
        } else {
            if (raw.length > settings.dataset.groupKeyMaxLength) {
                return fail(`The group name can be at most ${settings.dataset.groupKeyMaxLength} characters`);
            }
            if (!GROUP_KEY.test(raw)) return fail('A group name may use letters, numbers, spaces and . _ : -');
            patch.groupKey = raw;
        }
    }

    if (Object.keys(patch).length === 0) return fail('Nothing to change');
    return { patch };
}

function validateIds(plantId, imageIds) {
    if (!SAFE_ID.test(String(plantId || ''))) return fail('That is not a valid plant id');
    if (!Array.isArray(imageIds) || imageIds.length === 0) return fail('Pick at least one photo');
    if (imageIds.length > settings.dataset.maxBulk) return fail(`Pick at most ${settings.dataset.maxBulk} photos at a time`);
    if (!imageIds.every((id) => typeof id === 'string' && SAFE_ID.test(id))) return fail('That is not a valid photo id');
    return null;
}

async function inTransaction(db, fn) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        if (result && result.error) await conn.rollback(); else await conn.commit();
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

/** The approved photos of one plant with their training fields, plus the part list and counts. */
async function listTrainingPhotos(plantId, deps) {
    if (!SAFE_ID.test(String(plantId || ''))) return fail('That is not a valid plant id');
    const { db } = resolveDeps(deps);
    const [plants] = await db.query('SELECT plantId FROM plants WHERE plantId = ?', [plantId]);
    if (plants.length === 0) return fail('Plant not found', 404);
    const [rows] = await db.query(
        `SELECT imageId, trainingStatus, trainingReason, part, groupKey
         FROM plant_images
         WHERE plantId = ? AND status = 'approved' AND masterPurgedAt IS NULL
         ORDER BY isPrimary DESC, uploadedAt ASC`,
        [plantId]
    );
    const counts = { candidate: 0, included: 0, excluded: 0 };
    for (const r of rows) counts[r.trainingStatus] = (counts[r.trainingStatus] || 0) + 1;
    return {
        plantId,
        parts: settings.dataset.parts,
        statuses: STATUSES,
        counts,
        photos: rows.map((r) => ({
            imageId: r.imageId,
            trainingStatus: r.trainingStatus,
            trainingReason: r.trainingReason || '',
            part: r.part || '',
            groupKey: r.groupKey || ''
        }))
    };
}

/** Counts across every approved photo, and per species, for the dataset page. */
async function trainingSummary(deps) {
    const { db } = resolveDeps(deps);
    const [rows] = await db.query(
        `SELECT p.plantId, p.scientificName,
                SUM(i.trainingStatus = 'candidate') AS candidate,
                SUM(i.trainingStatus = 'included') AS included,
                SUM(i.trainingStatus = 'excluded') AS excluded,
                SUM(i.trainingStatus = 'included' AND i.part IS NULL) AS includedNoPart
         FROM plant_images i
         JOIN plants p ON p.plantId = i.plantId
         WHERE i.status = 'approved' AND i.masterPurgedAt IS NULL
         GROUP BY p.plantId, p.scientificName
         ORDER BY p.scientificName`
    );
    const species = rows.map((r) => ({
        plantId: r.plantId, scientificName: r.scientificName,
        candidate: Number(r.candidate), included: Number(r.included),
        excluded: Number(r.excluded), includedNoPart: Number(r.includedNoPart)
    }));
    const totals = species.reduce((t, s) => ({
        candidate: t.candidate + s.candidate, included: t.included + s.included,
        excluded: t.excluded + s.excluded, includedNoPart: t.includedNoPart + s.includedNoPart
    }), { candidate: 0, included: 0, excluded: 0, includedNoPart: 0 });
    return { totals, species };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Changes the training fields of several approved photos of ONE plant in one transaction.
 * All or none: if any photo is missing, belongs to another plant, is not approved or has lost its
 * master, nothing changes. Returns { ok, plantId, changed, patch } or { error, code }.
 */
async function setTraining(plantId, imageIds, input, deps) {
    const badIds = validateIds(plantId, imageIds);
    if (badIds) return badIds;
    const checked = validatePatch(input);
    if (checked.error) return checked;
    const { patch } = checked;
    const ids = [...new Set(imageIds)];
    const { db } = resolveDeps(deps);

    return inTransaction(db, async (conn) => {
        const [rows] = await conn.query(
            `SELECT imageId, status, masterPurgedAt FROM plant_images
             WHERE plantId = ? AND imageId IN (${ids.map(() => '?').join(',')}) FOR UPDATE`,
            [plantId, ...ids]
        );
        if (rows.length !== ids.length) return fail('A photo was not found on this plant', 404);
        const notApproved = rows.find((r) => r.status !== 'approved');
        if (notApproved) return fail('Only an approved photo can take part in training', 409);
        if (rows.some((r) => r.masterPurgedAt)) return fail('A photo has no file left, so it cannot take part in training', 409);

        const columns = Object.keys(patch);
        await conn.query(
            `UPDATE plant_images SET ${columns.map((c) => `\`${c}\` = ?`).join(', ')}
             WHERE plantId = ? AND imageId IN (${ids.map(() => '?').join(',')})`,
            [...columns.map((c) => patch[c]), plantId, ...ids]
        );
        return { ok: true, plantId, changed: ids.length, patch };
    });
}

/**
 * Sets every CANDIDATE photo of a plant to included (or excluded), in one step. Photos already
 * decided are left alone. `part` is applied to the photos that have none yet.
 */
async function decideCandidates(plantId, trainingStatus, part, deps) {
    if (!SAFE_ID.test(String(plantId || ''))) return fail('That is not a valid plant id');
    if (!['included', 'excluded'].includes(trainingStatus)) return fail('Choose included or excluded');
    let cleanPart;
    if (part) {
        const checked = validatePatch({ part });
        if (checked.error) return checked;
        cleanPart = checked.patch.part;
    }
    const { db } = resolveDeps(deps);
    return inTransaction(db, async (conn) => {
        const [rows] = await conn.query(
            `SELECT imageId, part FROM plant_images
             WHERE plantId = ? AND status = 'approved' AND masterPurgedAt IS NULL AND trainingStatus = 'candidate'
             FOR UPDATE`,
            [plantId]
        );
        if (rows.length === 0) return { ok: true, plantId, changed: 0, trainingStatus };
        const ids = rows.map((r) => r.imageId);
        await conn.query(
            `UPDATE plant_images SET trainingStatus = ?, trainingReason = NULL
             ${cleanPart ? ', part = COALESCE(part, ?)' : ''}
             WHERE plantId = ? AND imageId IN (${ids.map(() => '?').join(',')})`,
            [trainingStatus, ...(cleanPart ? [cleanPart] : []), plantId, ...ids]
        );
        return { ok: true, plantId, changed: ids.length, trainingStatus };
    });
}

module.exports = {
    STATUSES, validatePatch, normalizeName,
    listTrainingPhotos, trainingSummary, setTraining, decideCandidates
};
