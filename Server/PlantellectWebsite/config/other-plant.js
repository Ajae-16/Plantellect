// config/other-plant.js
//
// The Other plant inbox (Dataset page, Database view): scan contributions the model called "Other plant" have no plant
// (plantId NULL). This file helps an admin decide WHERE they belong, using the embedder chosen on the dataset page (a
// saved model such as convnexttiny, or MobileNet) in the ML service. It never decides for the admin and never moves a
// photo by itself; filing is config/training-photos.js bulkAssignUnassigned, called through assign() below.
//
//   suggest(imageIds)   for each photo, the existing plants it looks most like (score, best single match, margin)
//   groups(imageIds?)   the photos grouped by look-alike, each group with the existing plants it looks like. A group
//                       that looks like no plant is a possible NEW species: create the plant through the normal record
//                       flow, then file the group under it.
//   assign(...)         files photos under a plant in one step and says whether that plant can now be promoted
//
// What a suggestion is compared with: for every active plant, up to settings.otherPlant.refsPerPlant of its photos that a
// person has vouched for: recorded photos (origin 'record', approved) and scan contributions an admin INCLUDED, never a
// photo an admin EXCLUDED. Scan
// contributions that are still waiting are left out on purpose: they came from the model's own guesses, and comparing a
// photo with another unchecked guess would let one wrong prediction support the next one.
//
// The ML service keeps the vectors by photo id (masters never change), so each photo is sent once per embedder. A request
// embeds at most settings.otherPlant.embedBudget missing photos (the photos asked about first, then the references) and
// answers with how many are still to learn; pressing the button again continues. Nothing is lost between presses.
//
// The database, the ML service and the image tools are injected (`deps`) so the rules can be tested without them.

const settings = require('./settings');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KIND = /^(auto|mobilenet|thumb|saved|model:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/i;
const ML_MAX_REFERENCE_PHOTOS = 6000;      // the ML service refuses more in one request
const ML_MAX_PLANTS = 1500;
const ML_MAX_KEYS = 5000;
const PASS_THROUGH = [400, 404, 409, 503];

class OtherPlantError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
        this.expose = true;
    }
}

function resolveDeps(deps = {}) {
    return {
        // Lazy: choosing or listing embedders talks to the ML service only and must not need the database.
        get db() { return deps.db || require('./pool-mysql').mysqlPool; },
        fetchImpl: deps.fetchImpl || fetch,
        shrink: deps.shrink || shrinkMaster,
        masterFile: deps.masterFile || ((storedPath) => require('./public-images').masterFileOf(storedPath)),
        classes: deps.classes,
        training: deps.training || require('./training-photos'),
        species: deps.species || require('./species-promotion')
    };
}

// ---------------------------------------------------------------------------
// The ML service
// ---------------------------------------------------------------------------

/** Calls /embed<path> on the ML service. Returns the parsed JSON. Throws OtherPlantError with a message safe to show. */
async function mlCall(pathname, { method = 'GET', json, form } = {}, d) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.otherPlant.timeoutMs);
    let response;
    try {
        response = await d.fetchImpl(`${settings.ml.serviceUrl}/embed${pathname}`, {
            method, signal: controller.signal,
            headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
            body: json !== undefined ? JSON.stringify(json) : form
        });
    } catch (err) {
        throw new OtherPlantError(502, err && err.name === 'AbortError'
            ? 'The ML service took too long to answer. Try again with fewer photos.'
            : 'The ML service is not reachable');
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        let detail = null;
        try { detail = (await response.json()).detail; } catch (_) { /* not JSON */ }
        const message = typeof detail === 'string' ? detail : 'The ML service refused the request';
        throw new OtherPlantError(PASS_THROUGH.includes(response.status) ? response.status : 502, message);
    }
    return response.json();
}

/** A master as a small JPEG for the ML service. Orientation only; no metadata is kept. */
async function shrinkMaster(file) {
    const sharp = require('sharp');
    const edge = settings.otherPlant.sendLongEdge;
    return sharp(file, { limitInputPixels: settings.ingest.maxInputPixels, failOn: 'warning' })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
}

/** What can be chosen, what is chosen and what is loaded. { current, available: [{ kind, label, degraded }], loaded, stored }. */
function embedders(deps) {
    return mlCall('/embedders', {}, resolveDeps(deps));
}

/** Chooses the embedder. The ML service loads it first, so a model that cannot load is refused here, not at the next scan. */
function chooseEmbedder(kind, deps) {
    if (typeof kind !== 'string' || !KIND.test(kind.trim())) {
        return Promise.reject(new OtherPlantError(400, 'Choose MobileNet or one of the saved models'));
    }
    return mlCall('/embedder', { method: 'POST', json: { kind: kind.trim() } }, resolveDeps(deps));
}

// ---------------------------------------------------------------------------
// What is compared
// ---------------------------------------------------------------------------

/**
 * Up to refsPerPlant vouched-for photos of every active plant. Returns { plants: Map plantId -> [rows], truncated }.
 * Recorded photos come first, then included contributions; a plant's primary photo first among those.
 */
async function loadReferences(db) {
    const [rows] = await db.query(
        `SELECT r.imageId, r.plantId, r.storedPath FROM (
             SELECT i.imageId, i.plantId, i.storedPath,
                    ROW_NUMBER() OVER (PARTITION BY i.plantId
                                       ORDER BY (i.origin = 'record') DESC, i.isPrimary DESC, i.imageId ASC) AS rn
             FROM plant_images i
             JOIN plants p ON p.plantId = i.plantId
             WHERE i.status = 'approved' AND i.archivedAt IS NULL AND i.masterPurgedAt IS NULL
               AND i.trainingStatus <> 'excluded'
               AND (i.origin = 'record' OR i.trainingStatus = 'included')
               AND p.archivedAt IS NULL
         ) r
         WHERE r.rn <= ?
         ORDER BY r.plantId, r.rn`,
        [settings.otherPlant.refsPerPlant]
    );
    const plants = new Map();
    let truncated = false;
    let total = 0;
    for (const row of rows) {
        if (!plants.has(row.plantId)) {
            if (plants.size >= ML_MAX_PLANTS) { truncated = true; continue; }
            plants.set(row.plantId, []);
        }
        if (total >= ML_MAX_REFERENCE_PHOTOS) { truncated = true; continue; }
        plants.get(row.plantId).push(row);
        total += 1;
    }
    return { plants, truncated };
}

/**
 * Makes sure the ML service has a vector for these photos, sending at most the budget. `rows` are in priority order.
 * Returns { embedded, remaining, unreadable }:
 *   embedded    sent and embedded in this call
 *   remaining   still without a vector and still sendable (the admin presses the button again)
 *   unreadable  photos that cannot be sent (master file missing or not an image): they will never get a vector
 */
async function ensureVectors(rows, d) {
    const byId = new Map();
    for (const r of rows) if (!byId.has(r.imageId)) byId.set(r.imageId, r);
    const ids = [...byId.keys()];
    const missing = [];
    for (let i = 0; i < ids.length; i += ML_MAX_KEYS) {
        const answer = await mlCall('/missing', { method: 'POST', json: { keys: ids.slice(i, i + ML_MAX_KEYS) } }, d);
        missing.push(...(answer.missing || []));
    }
    const order = new Map(ids.map((id, i) => [id, i]));
    missing.sort((a, b) => order.get(a) - order.get(b));

    const budget = settings.otherPlant.embedBudget;
    let embedded = 0;
    let unreadable = 0;
    let cursor = 0;
    let sentBudget = 0;
    while (cursor < missing.length && sentBudget < budget) {
        const batch = [];
        while (cursor < missing.length && batch.length < settings.otherPlant.uploadBatch && sentBudget + batch.length < budget) {
            const row = byId.get(missing[cursor]);
            cursor += 1;
            const file = d.masterFile(row.storedPath);
            let bytes = null;
            if (file) { try { bytes = await d.shrink(file); } catch (_) { bytes = null; } }
            if (!bytes) { unreadable += 1; continue; }
            batch.push({ imageId: row.imageId, bytes });
        }
        if (batch.length === 0) continue;
        const form = new FormData();
        for (const item of batch) form.append('photos', new Blob([item.bytes], { type: 'image/jpeg' }), `${item.imageId}.jpg`);
        const answer = await mlCall('/add', { method: 'POST', form }, d);
        embedded += Number(answer.added) || 0;
        unreadable += (answer.skipped || []).length;
        sentBudget += batch.length;
    }
    return { embedded, remaining: Math.max(0, missing.length - cursor), unreadable };
}

/** The references as the ML service wants them: { plantId: [imageId] }. */
const referenceMap = (plants) => Object.fromEntries([...plants.entries()].map(([plantId, rows]) => [plantId, rows.map((r) => r.imageId)]));

// ---------------------------------------------------------------------------
// Answers, made readable
// ---------------------------------------------------------------------------

/** Adds names and promotion state to raw suggestions ([{ plantId, score, best, refs, margin? }]). */
async function describeSuggestions(lists, d) {
    const plantIds = [...new Set(lists.flatMap((list) => list.map((s) => s.plantId)))];
    const names = new Map();
    if (plantIds.length > 0) {
        const [rows] = await d.db.query(
            `SELECT plantId, scientificName, commonName FROM plants WHERE plantId IN (${plantIds.map(() => '?').join(',')})`,
            plantIds
        );
        rows.forEach((r) => names.set(r.plantId, r));
    }
    const classes = d.classes !== undefined ? d.classes : await d.species.loadActiveClassSet();
    const states = await d.species.describePlants(d.db, plantIds, { classes });
    return lists.map((list) => list.map((s) => {
        const plant = names.get(s.plantId) || {};
        const promo = states.get(s.plantId) || {};
        return {
            ...s,
            scientificName: plant.scientificName || s.plantId,
            commonName: plant.commonName || '',
            state: promo.state || null,                       // supported | promoted | other_plant (see species-promotion.js)
            uniquePhotos: promo.uniquePhotos === undefined ? null : promo.uniquePhotos,
            minimum: promo.minimum === undefined ? null : promo.minimum,
            minimumMet: Boolean(promo.minimumMet)
        };
    }));
}

function checkIds(imageIds, max) {
    if (!Array.isArray(imageIds) || imageIds.length === 0) throw new OtherPlantError(400, 'Pick at least one photo');
    if (imageIds.length > max) throw new OtherPlantError(400, `Pick at most ${max} photos at a time`);
    if (!imageIds.every((id) => typeof id === 'string' && SAFE_ID.test(id))) throw new OtherPlantError(400, 'That is not a valid photo id');
    return [...new Set(imageIds)];
}

const clampTopK = (value) => Math.min(10, Math.max(1, Number.parseInt(value, 10) || 3));

/** Shared by suggest() and groups(): loads the photos, makes sure vectors exist, returns what the ML call needs. */
async function prepare(imageIds, d) {
    const wanted = checkIds(imageIds, settings.otherPlant.maxPhotos);
    const candidates = await d.training.inboxFiles({ db: d.db }, wanted);
    if (candidates.length === 0) throw new OtherPlantError(404, 'None of these photos is waiting in the Other plant inbox any more. Reload the list.');
    const references = await loadReferences(d.db);
    const learning = await ensureVectors([...candidates, ...[...references.plants.values()].flat()], d);
    return { candidates, references, learning };
}

const learningNote = (learning, references) => ({
    embedded: learning.embedded, remaining: learning.remaining, unreadable: learning.unreadable,
    referencePlants: references.plants.size, referencePhotos: [...references.plants.values()].reduce((n, rows) => n + rows.length, 0),
    truncated: references.truncated
});

// ---------------------------------------------------------------------------
// Public: suggest / groups / assign
// ---------------------------------------------------------------------------

/**
 * For each photo, the plants it looks most like. Returns
 *   { embedder, degraded, suggestions: { imageId: [{ plantId, scientificName, commonName, state, score, best, refs, margin?,
 *     uniquePhotos, minimum, minimumMet }] }, learning: { embedded, remaining, unreadable, referencePlants, ... } }.
 * A photo that could not be embedded has no entry. Throws OtherPlantError.
 */
async function suggest({ imageIds, topK } = {}, deps) {
    const d = resolveDeps(deps);
    const { candidates, references, learning } = await prepare(imageIds, d);
    const answer = await mlCall('/suggest', {
        method: 'POST',
        json: { candidates: candidates.map((c) => c.imageId), references: referenceMap(references.plants), topK: clampTopK(topK) }
    }, d);
    const ids = Object.keys(answer.suggestions || {});
    const described = await describeSuggestions(ids.map((id) => answer.suggestions[id]), d);
    const suggestions = {};
    ids.forEach((id, i) => { suggestions[id] = described[i]; });
    return { embedder: answer.embedder, degraded: Boolean(answer.degraded), suggestions, learning: learningNote(learning, references) };
}

/**
 * The photos grouped by look-alike. imageIds omitted: the newest waiting photos of the inbox, at most maxPhotos.
 * options.threshold is the cosine similarity from which two photos share a group (the embedder decides what is sensible).
 * Returns { embedder, degraded, threshold, groups: [{ ids, size, cohesion, suggestions: [...] }], ungrouped, learning }.
 */
async function groups({ imageIds, threshold, topK } = {}, deps) {
    const d = resolveDeps(deps);
    let ids = imageIds;
    if (ids === undefined || ids === null) {
        const listed = await d.training.listUnassigned({ db: d.db }, { review: true, sort: 'newest', idsOnly: true });
        if (listed.error) throw new OtherPlantError(listed.code || 400, listed.error);
        ids = listed.ids.slice(0, settings.otherPlant.maxPhotos);
        if (ids.length === 0) return { embedder: null, degraded: false, threshold: null, groups: [], ungrouped: 0, learning: null };
    }
    const { candidates, references, learning } = await prepare(ids, d);
    const wanted = Number.parseFloat(threshold);
    const cut = Number.isFinite(wanted) ? Math.min(0.99, Math.max(0.5, wanted)) : settings.otherPlant.groupThreshold;
    const answer = await mlCall('/cluster', {
        method: 'POST',
        json: { keys: candidates.map((c) => c.imageId), references: referenceMap(references.plants), threshold: cut, topK: clampTopK(topK) }
    }, d);
    const described = await describeSuggestions((answer.groups || []).map((g) => g.suggestions || []), d);
    const out = (answer.groups || []).map((g, i) => ({ ids: g.ids, size: g.size, cohesion: g.cohesion, suggestions: described[i] }));
    const grouped = out.reduce((n, g) => n + g.size, 0);
    return {
        embedder: answer.embedder, degraded: Boolean(answer.degraded), threshold: cut, groups: out,
        ungrouped: candidates.length - grouped, learning: learningNote(learning, references)
    };
}

/**
 * Files photos under a plant (training-photos.js bulkAssignUnassigned) and reports where that plant stands for promotion,
 * so the page can offer "Promote" the moment the minimum is reached. Returns the assign result plus
 * { plant: { plantId, scientificName, state, uniquePhotos, minimum, minimumMet, canPromote } } or { error, code }.
 */
async function assign({ toPlantId, imageIds, include, part } = {}, deps) {
    const d = resolveDeps(deps);
    const result = await d.training.bulkAssignUnassigned(toPlantId, imageIds, { include, part }, { db: d.db });
    if (result.error) return result;
    let plant = null;
    try {
        const classes = d.classes !== undefined ? d.classes : await d.species.loadActiveClassSet();
        const described = await d.species.describePlants(d.db, [toPlantId], { classes });
        const promo = described.get(toPlantId);
        if (promo) {
            plant = {
                plantId: toPlantId, scientificName: promo.scientificName, state: promo.state, uniquePhotos: promo.uniquePhotos,
                minimum: promo.minimum, minimumMet: promo.minimumMet, canPromote: promo.canPromote, canUndo: promo.canUndo
            };
        }
    } catch (err) {
        // The photos are already filed; a promotion lookup that fails must not make the admin think they were not.
        console.error('Other plant: promotion state could not be read:', err.message);
    }
    return { ...result, plant };
}

module.exports = {
    OtherPlantError, embedders, chooseEmbedder, suggest, groups, assign,
    // exported for tests
    loadReferences, ensureVectors, KIND
};
