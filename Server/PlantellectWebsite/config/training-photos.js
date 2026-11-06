// Training status of approved photos (dataset handler).
//
// Four separate things live on a photo : status (review), publicVisible (public
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
// An ARCHIVED photo keeps its trainingStatus value but is ignored by everything here that lists or
// counts: the per-plant list, the summary and "decide every candidate". It is not a candidate any
// more, and unarchiving it brings it back with the status it had.
//
// Where a photo came from (plant_images.origin: 'record' or 'scan_contribution') is read here only to COUNT and
// FILTER the dataset page's summary (scan-contribution plan, stage 9). It never changes a training status: a scan
// contribution starts as a candidate like every other photo and only an admin's decision makes it included.
//
// The database is injected (`deps`) so the rules can be tested without MySQL. Callers pass nothing.

const settings = require('./settings');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = ['candidate', 'included', 'excluded'];
// The two values of plant_images.origin. The summary can be limited to one of them (the dataset page's origin filter).
const ORIGINS = ['record', 'scan_contribution'];
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
async function listTrainingPhotos(plantId, deps, options = {}) {
    if (!SAFE_ID.test(String(plantId || ''))) return fail('That is not a valid plant id');
    const { db } = resolveDeps(deps);
    const [plants] = await db.query('SELECT plantId FROM plants WHERE plantId = ?', [plantId]);
    if (plants.length === 0) return fail('Plant not found', 404);
    if (options && options.countsOnly) {
        // The admin editor shows photos a page at a time and each photo carries its own training
        // fields, so all it needs from here is the plant-wide counts and the part / status lists.
        const [grouped] = await db.query(
            `SELECT trainingStatus, COUNT(*) AS n
             FROM plant_images
             WHERE plantId = ? AND status = 'approved' AND masterPurgedAt IS NULL AND archivedAt IS NULL
             GROUP BY trainingStatus`,
            [plantId]
        );
        const counts = { candidate: 0, included: 0, excluded: 0 };
        for (const r of grouped) counts[r.trainingStatus] = Number(r.n) || 0;
        return { plantId, parts: settings.dataset.parts, statuses: STATUSES, counts, photos: [] };
    }
    const [rows] = await db.query(
        `SELECT imageId, trainingStatus, trainingReason, part, groupKey
         FROM plant_images
         WHERE plantId = ? AND status = 'approved' AND masterPurgedAt IS NULL AND archivedAt IS NULL
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

/**
 * Counts across every approved photo, and per species, for the dataset page.
 *
 * Besides the training counts, every species (and the totals) carries two numbers about scan contributions, the
 * private training-only photos a user offered after a very confident scan (stage 9):
 *   contribution            how many of its photos are scan contributions (archived ones are not counted, like
 *                           every other count here)
 *   contributionCandidate   how many of those still wait for an admin to include or exclude them
 *
 * `options.origin` limits the whole summary to one origin ('record' or 'scan_contribution'); '' or nothing means
 * every photo. A value that is neither returns { error, code: 400 }, so a typo never reads as "all photos".
 * The numbers always say which photos they cover: `origin` is echoed back ('' for all).
 */
async function trainingSummary(deps, options = {}) {
    const origin = options && options.origin != null ? options.origin : '';
    if (origin !== '' && !ORIGINS.includes(origin)) return fail(`The origin must be one of: ${ORIGINS.join(', ')}`);
    const { db } = resolveDeps(deps);
    const [rows] = await db.query(
        `SELECT p.plantId, p.scientificName,
                SUM(i.trainingStatus = 'candidate') AS candidate,
                SUM(i.trainingStatus = 'included') AS included,
                SUM(i.trainingStatus = 'excluded') AS excluded,
                SUM(i.trainingStatus = 'included' AND i.part IS NULL) AS includedNoPart,
                SUM(i.origin = 'scan_contribution') AS contribution,
                SUM(i.origin = 'scan_contribution' AND i.trainingStatus = 'candidate') AS contributionCandidate
         FROM plant_images i
         JOIN plants p ON p.plantId = i.plantId
         WHERE i.status = 'approved' AND i.masterPurgedAt IS NULL AND i.archivedAt IS NULL
           ${origin ? 'AND i.origin = ?' : ''}
         GROUP BY p.plantId, p.scientificName
         ORDER BY p.scientificName`,
        origin ? [origin] : []
    );
    const species = rows.map((r) => ({
        plantId: r.plantId, scientificName: r.scientificName,
        candidate: Number(r.candidate), included: Number(r.included),
        excluded: Number(r.excluded), includedNoPart: Number(r.includedNoPart),
        contribution: Number(r.contribution) || 0, contributionCandidate: Number(r.contributionCandidate) || 0
    }));
    const totals = species.reduce((t, s) => ({
        candidate: t.candidate + s.candidate, included: t.included + s.included,
        excluded: t.excluded + s.excluded, includedNoPart: t.includedNoPart + s.includedNoPart,
        contribution: t.contribution + s.contribution, contributionCandidate: t.contributionCandidate + s.contributionCandidate
    }), { candidate: 0, included: 0, excluded: 0, includedNoPart: 0, contribution: 0, contributionCandidate: 0 });
    return { origin, totals, species };
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
             WHERE plantId = ? AND status = 'approved' AND masterPurgedAt IS NULL AND archivedAt IS NULL
               AND trainingStatus = 'candidate'
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

// ---------------------------------------------------------------------------
// Scan contributions, grouped by the plant they are assigned to (the admin plants page)
// ---------------------------------------------------------------------------
//
// A scan contribution is filed under the plant the model named, so a wrong prediction puts a photo of
// one plant into another plant's dataset (a leak). These functions let an admin look at every contribution
// grouped by its current plant, MOVE the wrong ones to the right plant, and include a whole page of
// checked photos in the dataset at once.
//
// A contribution's master file is NOT moved when its plant changes: storedPath is the only thing readers
// use (a master's folder is named after a plantId or a requestId and never has to match the plant), so only
// the plantId changes. Contributions that are archived or have lost their master are not listed: they are out of use.

const CONTRIBUTION = 'scan_contribution';
// The pseudo plant id of scan contributions the model called "Other plant": they have no plant yet (plantId NULL).
// Only the contribution functions below understand it; a real plant id can never look like this.
const UNASSIGNED = '_unassigned';
const isUnassigned = (plantId) => plantId === UNASSIGNED;
/** SQL + params that select one plant's photos, or the unassigned ones. Alias i is plant_images. */
const ownerClause = (plantId) => (isUnassigned(plantId) ? { sql: 'i.plantId IS NULL', params: [] } : { sql: 'i.plantId = ?', params: [plantId] });
const LIVE_CONTRIBUTION = `i.origin = '${CONTRIBUTION}' AND i.status = 'approved' AND i.masterPurgedAt IS NULL AND i.archivedAt IS NULL`;
const GROUPS_PAGE_SIZE = 10;
const clampInt = (value, fallback, min, max) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * One page of plants that have scan contributions, with how many of each training status.
 * options: { page, pageSize (default 10), review: true to list only plants that still have a candidate }.
 */
async function listContributionGroups(deps, options = {}) {
    const { db } = resolveDeps(deps);
    const pageSize = clampInt(options.pageSize, GROUPS_PAGE_SIZE, 1, 100);
    const having = options.review ? 'HAVING SUM(i.trainingStatus = \'candidate\') > 0' : '';

    const [counted] = await db.query(
        `SELECT COUNT(*) AS n FROM (
             SELECT i.plantId FROM plant_images i WHERE ${LIVE_CONTRIBUTION} AND i.plantId IS NOT NULL GROUP BY i.plantId ${having}
         ) g`
    );
    const total = Number(counted[0].n) || 0;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(clampInt(options.page, 1, 1, 1000000), pages);

    const [rows] = await db.query(
        `SELECT p.plantId, p.scientificName, p.commonName, p.archivedAt,
                COUNT(*) AS total,
                SUM(i.trainingStatus = 'candidate') AS candidate,
                SUM(i.trainingStatus = 'included') AS included,
                SUM(i.trainingStatus = 'excluded') AS excluded,
                ROUND(AVG(i.contributionConfidence), 4) AS avgConfidence
         FROM plant_images i
         JOIN plants p ON p.plantId = i.plantId
         WHERE ${LIVE_CONTRIBUTION}
         GROUP BY p.plantId, p.scientificName, p.commonName, p.archivedAt
         ${having}
         ORDER BY p.scientificName ASC
         LIMIT ? OFFSET ?`,
        [pageSize, (page - 1) * pageSize]
    );
    const [all] = await db.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(i.trainingStatus = 'candidate'), 0) AS candidate,
                COALESCE(SUM(i.trainingStatus = 'included'), 0) AS included,
                COALESCE(SUM(i.trainingStatus = 'excluded'), 0) AS excluded
         FROM plant_images i WHERE ${LIVE_CONTRIBUTION}`
    );
    // Photos of an "Other plant" that no admin has assigned yet. One extra row at the top of page 1 (not counted in
    // the paging), because they are the ones that need a person first.
    const [loose] = await db.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(i.trainingStatus = 'candidate'), 0) AS candidate,
                COALESCE(SUM(i.trainingStatus = 'included'), 0) AS included,
                COALESCE(SUM(i.trainingStatus = 'excluded'), 0) AS excluded,
                ROUND(AVG(i.contributionConfidence), 4) AS avgConfidence
         FROM plant_images i WHERE i.plantId IS NULL AND ${LIVE_CONTRIBUTION}`
    );
    const unassignedGroup = Number(loose[0].total) > 0 && (!options.review || Number(loose[0].candidate) > 0) && page === 1
        ? [{
            plantId: UNASSIGNED, scientificName: 'Other plant (no plant assigned yet)', commonName: '', plantArchived: false, unassigned: true,
            total: Number(loose[0].total) || 0, candidate: Number(loose[0].candidate) || 0,
            included: Number(loose[0].included) || 0, excluded: Number(loose[0].excluded) || 0,
            avgConfidence: loose[0].avgConfidence === null || loose[0].avgConfidence === undefined ? null : Number(loose[0].avgConfidence)
        }]
        : [];
    return {
        page, pages, pageSize, total,
        totals: {
            total: Number(all[0].total) || 0, candidate: Number(all[0].candidate) || 0,
            included: Number(all[0].included) || 0, excluded: Number(all[0].excluded) || 0
        },
        groups: unassignedGroup.concat(rows.map((r) => ({
            plantId: r.plantId, scientificName: r.scientificName, commonName: r.commonName,
            plantArchived: Boolean(r.archivedAt),
            total: Number(r.total) || 0, candidate: Number(r.candidate) || 0,
            included: Number(r.included) || 0, excluded: Number(r.excluded) || 0,
            avgConfidence: r.avgConfidence === null || r.avgConfidence === undefined ? null : Number(r.avgConfidence)
        })))
    };
}

/**
 * One page of one plant's scan contributions, newest first, each with what the admin needs to judge it:
 * the confidence and model that offered it, who sent it, and its training fields.
 * options: { page, pageSize, review: true for candidates only }. Returns { error, code } for a bad or unknown plant.
 */
async function listContributionPhotos(plantId, deps, options = {}) {
    if (!SAFE_ID.test(String(plantId || ''))) return fail('That is not a valid plant id');
    const { db } = resolveDeps(deps);
    const owner = ownerClause(plantId);
    let plants;
    if (isUnassigned(plantId)) {
        plants = [{ scientificName: 'Other plant (no plant assigned yet)', commonName: '', archivedAt: null }];
    } else {
        [plants] = await db.query('SELECT plantId, scientificName, commonName, archivedAt FROM plants WHERE plantId = ?', [plantId]);
        if (plants.length === 0) return fail('Plant not found', 404);
    }

    const pageSize = clampInt(options.pageSize, 12, 1, 100);
    const extra = options.review ? " AND i.trainingStatus = 'candidate'" : '';
    const [counted] = await db.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(i.trainingStatus = 'candidate'), 0) AS candidate,
                COALESCE(SUM(i.trainingStatus = 'included'), 0) AS included,
                COALESCE(SUM(i.trainingStatus = 'excluded'), 0) AS excluded
         FROM plant_images i WHERE ${owner.sql} AND ${LIVE_CONTRIBUTION}`,
        owner.params
    );
    const counts = {
        total: Number(counted[0].total) || 0, candidate: Number(counted[0].candidate) || 0,
        included: Number(counted[0].included) || 0, excluded: Number(counted[0].excluded) || 0
    };
    const shown = options.review ? counts.candidate : counts.total;
    const pages = Math.max(1, Math.ceil(shown / pageSize));
    const page = Math.min(clampInt(options.page, 1, 1, 1000000), pages);

    const [rows] = await db.query(
        `SELECT i.imageId, i.uploadedAt, i.contributionConfidence, i.contributionModelId,
                i.trainingStatus, i.trainingReason, i.part, i.groupKey, a.username AS uploadedByName
         FROM plant_images i
         JOIN accounts a ON a.accountId = i.accountId
         WHERE ${owner.sql} AND ${LIVE_CONTRIBUTION}${extra}
         ORDER BY i.uploadedAt DESC, i.imageId ASC
         LIMIT ? OFFSET ?`,
        [...owner.params, pageSize, (page - 1) * pageSize]
    );
    return {
        plantId,
        scientificName: plants[0].scientificName,
        commonName: plants[0].commonName,
        plantArchived: Boolean(plants[0].archivedAt),
        unassigned: isUnassigned(plantId),
        page, pages, pageSize, total: shown, counts,
        parts: settings.dataset.parts,
        photos: rows.map((r) => ({
            imageId: r.imageId,
            uploadedAt: r.uploadedAt,
            uploadedByName: r.uploadedByName,
            confidence: r.contributionConfidence === null || r.contributionConfidence === undefined ? null : Number(r.contributionConfidence),
            modelId: r.contributionModelId || null,
            trainingStatus: r.trainingStatus,
            trainingReason: r.trainingReason || '',
            part: r.part || '',
            groupKey: r.groupKey || '',
            previewUrl: `/admin/api/plant-images/${encodeURIComponent(r.imageId)}`
        }))
    };
}

/** Active plants whose name matches the text, for the "move to" picker. At most 15, best match order by name. */
async function searchPlants(query, deps) {
    const q = String(query == null ? '' : query).trim().slice(0, 80);
    if (q.length < 2) return { plants: [] };
    const { db } = resolveDeps(deps);
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const [rows] = await db.query(
        `SELECT plantId, scientificName, commonName FROM plants
         WHERE archivedAt IS NULL AND (scientificName LIKE ? OR commonName LIKE ?)
         ORDER BY scientificName ASC LIMIT 15`,
        [like, like]
    );
    return { plants: rows.map((r) => ({ plantId: r.plantId, scientificName: r.scientificName, commonName: r.commonName })) };
}

/** Locks the named photos of one plant and checks that every one is a live scan contribution. */
async function lockContributions(conn, plantId, ids) {
    const owner = ownerClause(plantId);
    const [rows] = await conn.query(
        `SELECT imageId, origin, status, archivedAt, masterPurgedAt, trainingStatus FROM plant_images i
         WHERE ${owner.sql} AND i.imageId IN (${ids.map(() => '?').join(',')}) FOR UPDATE`,
        [...owner.params, ...ids]
    );
    if (rows.length !== ids.length) return { error: fail('A photo was not found on this plant. Reload the list and try again.', 404) };
    if (rows.some((r) => r.origin !== CONTRIBUTION)) return { error: fail('Only scan contributions can be handled here', 409) };
    if (rows.some((r) => r.status !== 'approved')) return { error: fail('Only an approved photo can take part in training', 409) };
    if (rows.some((r) => r.archivedAt)) return { error: fail('A photo is archived. Unarchive it on the plant first.', 409) };
    if (rows.some((r) => r.masterPurgedAt)) return { error: fail('A photo has no file left, so it cannot take part in training', 409) };
    return { rows };
}

/**
 * Moves scan contributions from one plant to another, in one transaction (all or none). Their training status goes
 * back to candidate (and a reason is dropped): a photo that was checked under the old plant has to be checked again
 * under the new one. Everything else on the row, including the confidence and model that offered it, stays.
 * The target must be an active plant. Returns { ok, fromPlantId, toPlantId, moved, resetToCandidate } or { error, code }.
 */
async function moveContributions(fromPlantId, toPlantId, imageIds, deps) {
    const badIds = validateIds(fromPlantId, imageIds);
    if (badIds) return badIds;
    if (!SAFE_ID.test(String(toPlantId || ''))) return fail('Choose the plant to move the photos to');
    if (fromPlantId === toPlantId) return fail('The photos are already on that plant');
    const ids = [...new Set(imageIds)];
    const { db } = resolveDeps(deps);

    return inTransaction(db, async (conn) => {
        // Both plants, locked in id order so two moves in opposite directions cannot deadlock.
        // Unassigned photos have no source plant to lock; only the target is.
        if (isUnassigned(toPlantId)) return fail('Choose a real plant to move the photos to');
        const [plants] = await conn.query(
            'SELECT plantId, archivedAt FROM plants WHERE plantId IN (?, ?) ORDER BY plantId FOR UPDATE',
            [fromPlantId, toPlantId]
        );
        const to = plants.find((p) => p.plantId === toPlantId);
        if (!isUnassigned(fromPlantId) && !plants.some((p) => p.plantId === fromPlantId)) return fail('Plant not found', 404);
        if (!to) return fail('The plant to move the photos to was not found', 404);
        if (to.archivedAt) return fail('That plant is archived. Restore it first, or choose another plant.', 409);

        const locked = await lockContributions(conn, fromPlantId, ids);
        if (locked.error) return locked.error;

        const resetToCandidate = locked.rows.filter((r) => r.trainingStatus !== 'candidate').length;
        const from = ownerClause(fromPlantId);
        await conn.query(
            `UPDATE plant_images i SET i.plantId = ?, i.trainingStatus = 'candidate', i.trainingReason = NULL
             WHERE ${from.sql} AND i.imageId IN (${ids.map(() => '?').join(',')})`,
            [toPlantId, ...from.params, ...ids]
        );
        return { ok: true, fromPlantId, toPlantId, moved: ids.length, resetToCandidate };
    });
}

/**
 * Includes the named scan contributions of one plant in the dataset: the admin looked at this page and they are all good.
 * Only photos still waiting (candidate) change; one that was already excluded or included is left as it is, because
 * somebody decided that on purpose. `part` fills the photos that have none. All or none for the checks; the counts say
 * how many were included and how many were left alone. Returns { ok, plantId, included, leftAlone } or { error, code }.
 */
async function includeContributions(plantId, imageIds, part, deps) {
    const badIds = validateIds(plantId, imageIds);
    if (badIds) return badIds;
    // A photo with no plant has no label, so it cannot be a training example yet: move it to its plant first.
    if (isUnassigned(plantId)) return fail('These photos have no plant yet. Move them to the right plant first, then include them.', 409);
    let cleanPart;
    if (part) {
        const checked = validatePatch({ part });
        if (checked.error) return checked;
        cleanPart = checked.patch.part;
    }
    const ids = [...new Set(imageIds)];
    const { db } = resolveDeps(deps);

    return inTransaction(db, async (conn) => {
        const locked = await lockContributions(conn, plantId, ids);
        if (locked.error) return locked.error;
        const waiting = locked.rows.filter((r) => r.trainingStatus === 'candidate').map((r) => r.imageId);
        if (waiting.length > 0) {
            await conn.query(
                `UPDATE plant_images SET trainingStatus = 'included', trainingReason = NULL
                 ${cleanPart ? ', part = COALESCE(part, ?)' : ''}
                 WHERE plantId = ? AND imageId IN (${waiting.map(() => '?').join(',')})`,
                [...(cleanPart ? [cleanPart] : []), plantId, ...waiting]
            );
        }
        return { ok: true, plantId, included: waiting.length, leftAlone: ids.length - waiting.length };
    });
}

/**
 * Excludes scan contributions of one plant (or of the unassigned group) from the dataset, with an optional reason.
 * Works on unassigned photos too, which the plant editor's training route cannot reach (they have no plant).
 * Returns { ok, plantId, excluded } or { error, code }.
 */
async function excludeContributions(plantId, imageIds, reason, deps) {
    const badIds = validateIds(plantId, imageIds);
    if (badIds) return badIds;
    const checked = validatePatch({ trainingStatus: 'excluded', trainingReason: reason == null ? '' : reason });
    if (checked.error) return checked;
    const ids = [...new Set(imageIds)];
    const { db } = resolveDeps(deps);

    return inTransaction(db, async (conn) => {
        const locked = await lockContributions(conn, plantId, ids);
        if (locked.error) return locked.error;
        const owner = ownerClause(plantId);
        await conn.query(
            `UPDATE plant_images i SET i.trainingStatus = 'excluded', i.trainingReason = ?
             WHERE ${owner.sql} AND i.imageId IN (${ids.map(() => '?').join(',')})`,
            [checked.patch.trainingReason, ...owner.params, ...ids]
        );
        return { ok: true, plantId, excluded: ids.length };
    });
}

// ---------------------------------------------------------------------------
// The Other plant inbox (Dataset page, Database view)
// ---------------------------------------------------------------------------
//
// Scan contributions the model called "Other plant" have no plant (plantId NULL, see config/scan-contribution.js), so
// no plantId-keyed query can reach them. The inbox is where an admin sees ALL of them, newest or most confident first,
// and files them under a plant in bulk. Two rules shape it:
//   * Nothing here makes a photo public or puts it in a snapshot by itself. A photo with no plant is not a training
//     example (it has no label). It becomes one only after it is assigned, and then only if the admin ticks "include".
//   * Assigning does not move the master file. A master's folder never has to match its plant (storedPath is the only
//     thing readers use), so the file stays under plants/masters/_other_plant/ and only the row changes. Snapshots hard-link
//     from storedPath, so they are not affected either.

const clampFloat = (value, fallback, min, max) => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const INBOX_SORTS = { newest: 'i.uploadedAt DESC, i.imageId ASC', oldest: 'i.uploadedAt ASC, i.imageId ASC', confidence: 'i.contributionConfidence DESC, i.imageId ASC' };

/**
 * The unassigned photos, filtered and sorted. options:
 *   page, pageSize (default 24), review (true = only photos still waiting), sort ('newest' | 'oldest' | 'confidence'),
 *   minConfidence / maxConfidence (0 to 1), modelId (only photos offered by that model)
 *   idsOnly: true returns just { ids, total, capped } for every match, at most settings.dataset.maxBulkMove ids, so the
 *   page can offer "select all N matching" without holding thousands of photo cards.
 * `counts` always describe ALL unassigned photos; `total` is what the filter matches.
 */
async function listUnassigned(deps, options = {}) {
    const { db } = resolveDeps(deps);
    const where = [`i.plantId IS NULL`, LIVE_CONTRIBUTION];
    const params = [];
    if (options.review) where.push(`i.trainingStatus = 'candidate'`);
    const min = options.minConfidence === undefined || options.minConfidence === '' || options.minConfidence === null ? null : clampFloat(options.minConfidence, null, 0, 1);
    const max = options.maxConfidence === undefined || options.maxConfidence === '' || options.maxConfidence === null ? null : clampFloat(options.maxConfidence, null, 0, 1);
    if (min !== null) { where.push('i.contributionConfidence >= ?'); params.push(min); }
    if (max !== null) { where.push('i.contributionConfidence <= ?'); params.push(max); }
    if (options.modelId) {
        if (!SAFE_ID.test(String(options.modelId))) return fail('That is not a valid model id');
        where.push('i.contributionModelId = ?'); params.push(String(options.modelId));
    }
    const order = INBOX_SORTS[options.sort] || INBOX_SORTS.newest;

    const [all] = await db.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(i.trainingStatus = 'candidate'), 0) AS candidate,
                COALESCE(SUM(i.trainingStatus = 'excluded'), 0) AS excluded,
                ROUND(AVG(i.contributionConfidence), 4) AS avgConfidence
         FROM plant_images i WHERE i.plantId IS NULL AND ${LIVE_CONTRIBUTION}`
    );
    const counts = {
        total: Number(all[0].total) || 0, candidate: Number(all[0].candidate) || 0, excluded: Number(all[0].excluded) || 0,
        avgConfidence: all[0].avgConfidence === null || all[0].avgConfidence === undefined ? null : Number(all[0].avgConfidence)
    };
    const [matched] = await db.query(`SELECT COUNT(*) AS n FROM plant_images i WHERE ${where.join(' AND ')}`, params);
    const total = Number(matched[0].n) || 0;

    if (options.idsOnly) {
        const cap = settings.dataset.maxBulkMove;
        const [rows] = await db.query(
            `SELECT i.imageId FROM plant_images i WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
            [...params, cap]
        );
        return { unassigned: true, counts, total, ids: rows.map((r) => r.imageId), capped: total > rows.length, cap };
    }

    const pageSize = clampInt(options.pageSize, 24, 1, 100);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(clampInt(options.page, 1, 1, 1000000), pages);
    const [rows] = await db.query(
        `SELECT i.imageId, i.uploadedAt, i.contributionConfidence, i.contributionModelId,
                i.trainingStatus, i.trainingReason, i.part, i.groupKey, a.username AS uploadedByName
         FROM plant_images i
         JOIN accounts a ON a.accountId = i.accountId
         WHERE ${where.join(' AND ')}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
        [...params, pageSize, (page - 1) * pageSize]
    );
    const [modelRows] = await db.query(
        `SELECT DISTINCT i.contributionModelId AS modelId FROM plant_images i
         WHERE i.plantId IS NULL AND ${LIVE_CONTRIBUTION} AND i.contributionModelId IS NOT NULL ORDER BY 1`
    );
    return {
        plantId: UNASSIGNED, unassigned: true, page, pages, pageSize, total, counts,
        models: modelRows.map((r) => r.modelId),
        parts: settings.dataset.parts,
        photos: rows.map((r) => ({
            imageId: r.imageId,
            uploadedAt: r.uploadedAt,
            uploadedByName: r.uploadedByName,
            confidence: r.contributionConfidence === null || r.contributionConfidence === undefined ? null : Number(r.contributionConfidence),
            modelId: r.contributionModelId || null,
            trainingStatus: r.trainingStatus,
            trainingReason: r.trainingReason || '',
            part: r.part || '',
            groupKey: r.groupKey || '',
            previewUrl: `/admin/api/plant-images/${encodeURIComponent(r.imageId)}`
        }))
    };
}

/** The named photos that are still in the inbox, as [{ imageId, storedPath }], in the order asked (config/other-plant.js sends them to be embedded). */
async function inboxFiles(deps, imageIds) {
    const { db } = resolveDeps(deps);
    const [rows] = await db.query(
        `SELECT i.imageId, i.storedPath FROM plant_images i
         WHERE i.plantId IS NULL AND ${LIVE_CONTRIBUTION} AND i.imageId IN (${imageIds.map(() => '?').join(',')})`,
        imageIds
    );
    const byId = new Map(rows.map((r) => [r.imageId, r]));
    return imageIds.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Files unassigned photos under ONE plant, in one transaction (all or none). options: { include, part }.
 *
 *   The photos take the plant's id and go back to 'candidate' (and a reason is dropped): a photo nobody has labelled yet
 *   has to be judged under its new plant, the same rule as moveContributions.
 *   include: true then sets the photos that were WAITING to 'included' in the same step, because the admin who picks the
 *   plant for a whole batch has just looked at the batch. A photo that had been EXCLUDED is moved but stays a candidate:
 *   someone decided against it on purpose, so moving it is not also a decision to train on it. leftForReview counts them.
 *   part fills the photos that have none (organisation only, never a label).
 *
 * At most settings.dataset.maxBulkMove photos. Returns { ok, toPlantId, moved, included, leftForReview } or { error, code }.
 */
async function bulkAssignUnassigned(toPlantId, imageIds, options, deps) {
    const cap = settings.dataset.maxBulkMove;
    if (!SAFE_ID.test(String(toPlantId || '')) || isUnassigned(toPlantId)) return fail('Choose the plant to file the photos under');
    if (!Array.isArray(imageIds) || imageIds.length === 0) return fail('Pick at least one photo');
    if (imageIds.length > cap) return fail(`Pick at most ${cap} photos at a time`);
    if (!imageIds.every((id) => typeof id === 'string' && SAFE_ID.test(id))) return fail('That is not a valid photo id');
    const include = Boolean(options && options.include);
    let cleanPart;
    if (options && options.part) {
        const checked = validatePatch({ part: options.part });
        if (checked.error) return checked;
        cleanPart = checked.patch.part;
    }
    const ids = [...new Set(imageIds)];
    const { db } = resolveDeps(deps);

    return inTransaction(db, async (conn) => {
        const [plants] = await conn.query('SELECT plantId, archivedAt FROM plants WHERE plantId = ? FOR UPDATE', [toPlantId]);
        if (!plants[0]) return fail('The plant to file the photos under was not found', 404);
        if (plants[0].archivedAt) return fail('That plant is archived. Restore it first, or choose another plant.', 409);

        const locked = await lockContributions(conn, UNASSIGNED, ids);
        if (locked.error) return locked.error;

        const waiting = locked.rows.filter((r) => r.trainingStatus === 'candidate').map((r) => r.imageId);
        const marks = ids.map(() => '?').join(',');
        await conn.query(
            `UPDATE plant_images i SET i.plantId = ?, i.trainingStatus = 'candidate', i.trainingReason = NULL
             ${cleanPart ? ', i.part = COALESCE(i.part, ?)' : ''}
             WHERE i.plantId IS NULL AND i.imageId IN (${marks})`,
            [toPlantId, ...(cleanPart ? [cleanPart] : []), ...ids]
        );
        if (include && waiting.length > 0) {
            await conn.query(
                `UPDATE plant_images SET trainingStatus = 'included', trainingReason = NULL
                 WHERE plantId = ? AND imageId IN (${waiting.map(() => '?').join(',')})`,
                [toPlantId, ...waiting]
            );
        }
        const included = include ? waiting.length : 0;
        return { ok: true, toPlantId, moved: ids.length, included, leftForReview: ids.length - included };
    });
}

module.exports = {
    UNASSIGNED,
    STATUSES, ORIGINS, validatePatch, normalizeName,
    listTrainingPhotos, trainingSummary, setTraining, decideCandidates,
    listContributionGroups, listContributionPhotos, searchPlants, moveContributions, includeContributions, excludeContributions,
    listUnassigned, inboxFiles, bulkAssignUnassigned
};
