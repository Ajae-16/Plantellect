// /admin/dataset (page) and /admin/api/dataset/* (JSON).
//
// This file only checks who is asking, validates the input, logs changes and passes the request on to the
// ML service, which owns the dataset folder (it is mounted there). No path ever travels in a request: photos
// are named by an opaque id, clusters by their id, species by name.
//
//   views      access_admin
//   changes    manage_plant
//
// (database-linked dataset) is served here too, from MySQL rather than the ML service:
//   GET  /api/plants/:plantId/training    training status, part and group of a plant's approved photos
//   POST /api/plants/:plantId/training    change them (one photo, several, or every candidate)
//   GET  /api/dataset/db/summary          counts for the dataset page
//   GET/POST /api/dataset/db/snapshots    list, and build a database snapshot for the split script
//  a snapshot files a promoted species under Plant and caps Other plant photos per species
//   (settings.dataset.otherPlantCap, reported by /api/dataset/db/summary and in each snapshot's summary).
// Species promotion (/api/dataset/species*) does not go through the ML service: it reads the database and the
// active model's classes.json, so it is answered here (config/species-promotion.js).

const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const { requirePermission } = require('../middleware/authMiddleware');
const settings = require('../config/settings');
const trainingPhotos = require('../config/training-photos');
const dbSnapshot = require('../config/db-snapshot');
const { logAuthEvent } = require('../mongoose-schemas/Authlog');
const species = require('../config/species-promotion');

const router = express.Router();
const adminDir = path.join(__dirname, '..', 'administration', 'admin');
const view = requirePermission('access_admin');
const change = requirePermission('manage_plant');

const PID = /^[0-9a-f]{16}$/;
const SHA = /^[0-9a-f]{64}$/;
// Optional: the host folder that the ML container shows as <datasets>/index/thumbs. When it is set, thumbnails
// are sent straight from disk (no hop through the ML service); when it is not, they are fetched from it.
const THUMBS_DIR = process.env.DATASET_THUMBS_DIR ? path.resolve(process.env.DATASET_THUMBS_DIR) : '';
const CLUSTER = /^[0-9a-f]{12}$/;
const CATEGORIES = ['LEAK', 'CROSS_CLASS', 'SIMILAR_LEAK', 'REDUNDANT'];
const SPLITS = ['train', 'val', 'test', 'pool'];
const KINDS = ['species', 'other_plant', 'non_plant'];

router.get('/dataset', view, (req, res) => res.sendFile(path.join(adminDir, 'admin-dataset.html')));

// ---------------------------------------------------------------------------
// ML service
// ---------------------------------------------------------------------------

class MlError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

/** Calls the ML service. Returns the parsed JSON, or the raw Response when raw is true. */
async function ml(pathAndQuery, { method = 'GET', body, raw = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.ml.timeoutMs);
    let response;
    try {
        response = await fetch(`${settings.ml.serviceUrl}/dataset${pathAndQuery}`, {
            method, signal: controller.signal,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined
        });
    } catch (err) {
        throw new MlError(502, 'The ML service is not reachable');
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        let detail = null;
        try { detail = (await response.json()).detail; } catch (_) { /* not JSON */ }
        const message = typeof detail === 'string' ? detail : 'The ML service refused the request';
        throw new MlError([400, 404, 409, 503].includes(response.status) ? response.status : 502, message);
    }
    return raw ? response : response.json();
}

function handle(fn) {
    return async (req, res) => {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof MlError) return res.status(err.status).json({ error: err.message });
            if (err instanceof species.SpeciesError) return res.status(err.status).json({ error: err.message });
            console.error('Dataset route error:', err.message);
            res.status(500).json({ error: 'Something went wrong' });
        }
    };
}

const audit = (req, metadata) => logAuthEvent({
    accountId: req.session.accountId, action: 'dataset_changed', ip: req.ip,
    userAgent: req.get('User-Agent') || '', metadata
});

const intIn = (value, fallback, min, max) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function pidList(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
    return value.every((p) => typeof p === 'string' && PID.test(p)) ? [...new Set(value)] : null;
}

const query = (params) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== '' && v != null) qs.set(k, String(v)); });
    const s = qs.toString();
    return s ? `?${s}` : '';
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

router.get('/api/dataset/overview', view, handle(async (req, res) => {
    const [overview, status] = await Promise.all([ml('/overview'), ml('/status')]);
    res.json({ ...overview, run: status });
}));

router.get('/api/dataset/status', view, handle(async (req, res) => res.json(await ml('/status'))));

router.get('/api/dataset/clusters', view, handle(async (req, res) => {
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : '';
    res.json(await ml('/clusters' + query({
        category, reviewed: req.query.reviewed === '1' ? 1 : 0,
        page: intIn(req.query.page, 1, 1, 10000), size: intIn(req.query.pageSize, 10, 1, 30)
    })));
}));

router.get('/api/dataset/mislabels', view, handle(async (req, res) => {
    res.json(await ml('/mislabels' + query({ page: intIn(req.query.page, 1, 1, 10000), size: intIn(req.query.pageSize, 10, 1, 30) })));
}));

router.get('/api/dataset/grid', view, handle(async (req, res) => res.json(await ml('/grid'))));

router.get('/api/dataset/browse', view, handle(async (req, res) => {
    res.json(await ml('/browse' + query({
        label: text(req.query.label, 120), part: text(req.query.part, 40),
        split: SPLITS.includes(req.query.split) ? req.query.split : '',
        kind: KINDS.includes(req.query.kind) ? req.query.kind : '',
        page: intIn(req.query.page, 1, 1, 10000), size: intIn(req.query.pageSize, 24, 1, 60)
    })));
}));

router.get('/api/dataset/destinations', view, handle(async (req, res) => res.json(await ml('/destinations'))));

router.get('/api/dataset/quarantine', view, handle(async (req, res) => res.json(await ml('/quarantine'))));

router.get('/api/dataset/folder', view, handle(async (req, res) => {
    res.json(await ml('/folder' + query({
        split: SPLITS.includes(req.query.split) ? req.query.split : '',
        kind: KINDS.includes(req.query.kind) ? req.query.kind : '',
        label: text(req.query.label, 120), part: text(req.query.part, 40), source: text(req.query.source, 200),
        page: intIn(req.query.page, 1, 1, 10000), size: intIn(req.query.pageSize, 24, 1, 60)
    })));
}));

async function proxyThumb(req, res) {
    try {
        const upstream = await ml(`/thumb/${req.params.pid}`, { raw: true });
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
        if (!res.headersSent) res.status(err instanceof MlError ? err.status : 500).json({ error: err.message });
    }
}

/**
 * A photo of the dataset, as a small thumbnail. The page passes the file's hash (?s=) so a thumbnail that already
 * exists is sent from disk at once; the hash is checked to be 64 hex characters, so it cannot name any other path.
 */
router.get('/api/dataset/thumb/:pid', view, (req, res) => {
    if (!PID.test(req.params.pid)) return res.status(404).json({ error: 'Photo not found' });
    const sha = req.query.s;
    if (THUMBS_DIR && typeof sha === 'string' && SHA.test(sha)) {
        return res.sendFile(`${sha.slice(0, 2)}/${sha}.jpg`, {
            root: THUMBS_DIR, dotfiles: 'deny',
            headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }
        }, (err) => { if (err && !res.headersSent) proxyThumb(req, res); });
    }
    return proxyThumb(req, res);
});

const PLANT_ID = /^[A-Za-z0-9_-]{1,18}$/;
const SPECIES_STATES = ['promoted', 'other_plant', 'supported'];
const db = () => require('../config/pool-mysql').mysqlPool;

/** Species promotion table: Other plant, promoted (waiting for a retrain) and supported species. */
router.get('/api/dataset/species', view, handle(async (req, res) => {
    res.json(await species.listSpecies(db(), {
        classes: await species.loadActiveClassSet(),
        state: SPECIES_STATES.includes(req.query.state) ? req.query.state : '',
        page: intIn(req.query.page, 1, 1, 10000), pageSize: intIn(req.query.pageSize, 25, 1, 100)
    }));
}));

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

router.post('/api/dataset/audit', change, handle(async (req, res) => {
    const out = await ml('/audit', { method: 'POST', body: {} });
    await audit(req, { action: 'audit_started' });
    res.status(202).json(out);
}));

router.post('/api/dataset/review', change, handle(async (req, res) => {
    const { clusterId, decision } = req.body || {};
    if (!CLUSTER.test(clusterId || '') || !['kept', 'removed'].includes(decision)) return res.status(400).json({ error: 'Bad request' });
    await ml('/review', { method: 'POST', body: { clusterId, decision } });
    await audit(req, { action: 'cluster_reviewed', clusterId, decision });
    res.json({ ok: true });
}));

/** Moves photos to the quarantine folder. Nothing is deleted. */
router.post('/api/dataset/remove', change, handle(async (req, res) => {
    const pids = pidList(req.body && req.body.pids);
    if (!pids) return res.status(400).json({ error: 'Pick between 1 and 50 photos' });
    const note = text(req.body.note, 200) || 'removed from the dataset';
    const out = await ml('/quarantine', { method: 'POST', body: { pids, note } });
    const clusterId = req.body.clusterId;
    if (CLUSTER.test(clusterId || '')) await ml('/review', { method: 'POST', body: { clusterId, decision: 'removed' } });
    await audit(req, { action: 'photos_quarantined', moved: out.moved, missing: (out.missing || []).length, clusterId: clusterId || null, note });
    res.json(out);
}));

router.post('/api/dataset/restore', change, handle(async (req, res) => {
    const qid = req.body && req.body.qid;
    if (!PID.test(qid || '')) return res.status(400).json({ error: 'Bad request' });
    const out = await ml('/restore', { method: 'POST', body: { qid } });
    await audit(req, { action: 'photo_restored', qid });
    res.json(out);
}));

/**
 * Moves photos to another folder of the dataset (another split, kind, species or part). With preview: true it only
 * reports what would happen and any warnings (for example that a photo would be separated from its group).
 */
router.post('/api/dataset/move', change, handle(async (req, res) => {
    const body = req.body || {};
    const pids = pidList(body.pids);
    const d = body.dest;
    if (!pids) return res.status(400).json({ error: 'Pick between 1 and 50 photos' });
    if (!d || typeof d !== 'object' || !KINDS.includes(d.kind) || (d.split && !SPLITS.includes(d.split) || d.split === 'pool')) {
        return res.status(400).json({ error: 'Choose where to move the photos' });
    }
    const dest = { split: d.split || '', kind: d.kind, label: text(d.label, 120), part: text(d.part, 40) };
    const preview = body.preview === true;
    const out = await ml('/move', { method: 'POST', body: { pids, dest, preview } });
    if (!preview) await audit(req, { action: 'photos_moved', moved: out.moved, to: out.to, warnings: (out.warnings || []).length });
    res.json(out);
}));

/** These photos must always land in the same split. */
router.post('/api/dataset/group', change, handle(async (req, res) => {
    const pids = pidList(req.body && req.body.pids);
    if (!pids || pids.length < 2) return res.status(400).json({ error: 'Pick at least two photos' });
    const out = await ml('/group', { method: 'POST', body: { pids } });
    const clusterId = req.body.clusterId;
    if (CLUSTER.test(clusterId || '')) await ml('/review', { method: 'POST', body: { clusterId, decision: 'kept' } });
    await audit(req, { action: 'photos_grouped', group: out.group, photos: out.photos, clusterId: clusterId || null });
    res.json(out);
}));

/** A new part row, optionally with its folders for one species. */
router.post('/api/dataset/parts', change, handle(async (req, res) => {
    const part = text(req.body && req.body.part, 40);
    const species = text(req.body && req.body.species, 120);
    if (!part) return res.status(400).json({ error: 'A part name is required' });
    const out = await ml('/parts', { method: 'POST', body: { part, species } });
    await audit(req, { action: 'part_added', part: out.part, species: species || null, folders: out.created.length });
    res.json(out);
}));

/** Records the decision to promote a species. The next retrain, not this, makes scans identify it. */
router.post('/api/dataset/species/promote', change, handle(async (req, res) => {
    const plantId = req.body && req.body.plantId;
    if (typeof plantId !== 'string' || !PLANT_ID.test(plantId)) return res.status(400).json({ error: 'Bad request' });
    const out = await species.promoteSpecies(db(), { plantId, accountId: req.session.accountId, note: text(req.body.note, 255), classes: await species.loadActiveClassSet() });
    if (out.changed) await audit(req, { action: 'species_promoted', plantId, scientificName: out.species.scientificName, uniquePhotos: out.species.uniquePhotos });
    res.json(out);
}));

/** Takes a promotion back, while the active model does not list the species yet. */
router.post('/api/dataset/species/unpromote', change, handle(async (req, res) => {
    const plantId = req.body && req.body.plantId;
    if (typeof plantId !== 'string' || !PLANT_ID.test(plantId)) return res.status(400).json({ error: 'Bad request' });
    const out = await species.undoPromotion(db(), { plantId, accountId: req.session.accountId, note: text(req.body.note, 255), classes: await species.loadActiveClassSet() });
    await audit(req, { action: 'species_unpromoted', plantId, scientificName: out.species.scientificName });
    res.json(out);
}));

// ---------------------------------------------------------------------------
// training status of approved photos, and database snapshots
// ---------------------------------------------------------------------------

/** Sends a { error, code } result as JSON with its status, anything else as { ok: true, ... }. */
function sendResult(res, result) {
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    return res.json({ ok: true, ...result });
}

router.get('/api/plants/:plantId/training', view, handle(async (req, res) => {
    sendResult(res, await trainingPhotos.listTrainingPhotos(req.params.plantId));
}));

/**
 * Body: { imageIds: [...], trainingStatus?, trainingReason?, part?, groupKey? }
 *   or: { allCandidates: true, trainingStatus: 'included' | 'excluded', part? }  (decides every candidate at once)
 */
router.post('/api/plants/:plantId/training', change, handle(async (req, res) => {
    const body = req.body || {};
    const { plantId } = req.params;
    let result;
    if (body.allCandidates === true) {
        result = await trainingPhotos.decideCandidates(plantId, body.trainingStatus, body.part);
    } else {
        result = await trainingPhotos.setTraining(plantId, body.imageIds, body);
    }
    if (!result.error) {
        await audit(req, {
            action: 'training_changed', plantId, photos: result.changed,
            trainingStatus: result.trainingStatus || (result.patch && result.patch.trainingStatus) || null,
            part: result.patch && 'part' in result.patch ? result.patch.part : undefined,
            groupChanged: Boolean(result.patch && 'groupKey' in result.patch)
        });
    }
    sendResult(res, result);
}));

router.get('/api/dataset/db/summary', view, handle(async (req, res) => {
    res.json({ ...(await trainingPhotos.trainingSummary()), otherPlantCap: settings.dataset.otherPlantCap });
}));

router.get('/api/dataset/db/snapshots', view, handle(async (req, res) => {
    res.json({ items: await dbSnapshot.listSnapshots() });
}));

router.post('/api/dataset/db/snapshots', change, handle(async (req, res) => {
    const result = await dbSnapshot.buildSnapshot();
    if (!result.error) {
        await audit(req, { action: 'db_snapshot_built', snapshot: result.name, photos: result.counts.photos, skipped: result.counts.skipped });
    }
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    // The folder on this computer is not sent to the browser: only its name, which is what the split script takes.
    const { dir, ...rest } = result;
    res.status(201).json(rest);
}));

module.exports = router;
