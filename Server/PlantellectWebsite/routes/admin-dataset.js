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
//   GET  /api/dataset/db/summary          counts for the dataset page; ?origin= limits them to recorded photos or to scan
//                                         contributions (stage 9, the values are listed by training-photos.js), and every
//                                         species also carries its scan contribution counts
//   GET/POST /api/dataset/db/snapshots    list, and build a database snapshot for the split script
//  a snapshot files a promoted species under Plant and caps Other plant photos per species
//   (settings.dataset.otherPlantCap, reported by /api/dataset/db/summary and in each snapshot's summary).
// The Other plant inbox (/api/dataset/db/other-plant*): scan contributions the model called "Other plant" have no plant yet.
//   GET  /api/dataset/db/other-plant            one page of them (?page&review=1&sort=newest|oldest|confidence&min&max&modelId)
//   GET  /api/dataset/db/other-plant/ids        every id the same filter matches (capped), for "select all N matching"
//   POST /api/dataset/db/other-plant/assign     file photos under a plant in bulk { toPlantId, imageIds, include?, part? }
//   POST /api/dataset/db/other-plant/suggest    which existing plants each photo looks like { imageIds, topK? }
//   POST /api/dataset/db/other-plant/groups     photos grouped by look-alike, with the plants each group looks like
//   GET  /api/dataset/db/other-plant/embedders  which embedder the ML service uses, and the ones that can be chosen
//   POST /api/dataset/db/other-plant/embedder   choose one (MobileNet or a saved model) { kind }
//   Views need access_admin, changes need manage_plant. Logic is in config/training-photos.js and config/other-plant.js.
// The audit:
//   POST /api/dataset/audit          start one; 409 code 'recent_audit' when the last ended under 10 minutes ago, unless { confirm: true }
//   GET/PUT /api/dataset/audit-settings   the model that compares photos + the two similarity thresholds (Dataset page and Settings page)
// Species promotion (/api/dataset/species*) does not go through the ML service: it reads the database and the
// active model's classes.json, so it is answered here (config/species-promotion.js).
// Several admins at once (config/dataset-sync.js):
//   GET  /api/dataset/sync            "did anything change?": the change counters, the newest change-log rows and everyone's
//                                     "working on this" markers. Sends an ETag built from the counters; a page that sends it
//                                     back in If-None-Match gets a bodyless 304 while nothing has changed.
//   POST /api/dataset/locks           mark items as "I am working on this" (a claim; renewed by calling it again) { keys, purpose }
//   POST /api/dataset/locks/release   let go of claims { keys } or { all: true }; also what the page's sendBeacon calls on close
//                                     ({ all: true } keeps species locks: a reload must not drop them)
//   POST /api/dataset/locks/species   lock a species folder (train, val and test together) { label }; 409 { code: 'locked' } when
//                                     another admin holds it; calling it again renews it. Release it with locks/release { keys: [key] }.
//   POST /api/dataset/locks/species/renew   the open page's heartbeat { keys }: renews the species locks this admin still holds and
//                                     says which were lost
//   Remove, move, group and put-back also check the species lock of every species the photos are in, so a locked species is changed
//   by its owner only. The one softer case: moving photos INTO a species another admin locked is a warning (preview) and then needs
//   `confirmLocked: true` (409 { code: 'dest_locked' } without it).
//   Every route that changes something takes an operation lock on the items it touches (409 { code: 'locked', lockedBy } when
//   another admin holds one) and writes a change-log row + counters when it succeeds.

const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const { requirePermission } = require('../middleware/authMiddleware');
const settings = require('../config/settings');
const trainingPhotos = require('../config/training-photos');
const dbSnapshot = require('../config/db-snapshot');
const { logAuthEvent } = require('../mongoose-schemas/Authlog');
const species = require('../config/species-promotion');
const otherPlant = require('../config/other-plant');
const datasetAudit = require('../config/dataset-audit');
const datasetSync = require('../config/dataset-sync');

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
            if (err instanceof datasetSync.LockedError) return res.status(409).json({ error: err.message, code: 'locked', lockedBy: err.lockedBy });
            if (err instanceof species.SpeciesError) return res.status(err.status).json({ error: err.message });
            if (err instanceof otherPlant.OtherPlantError) return res.status(err.status).json({ error: err.message });
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
// Several admins at once: who is asking, operation locks, and the change log
// ---------------------------------------------------------------------------

const photosN = (n) => `${n} photo${n === 1 ? '' : 's'}`;

/** The signed-in admin as the lock owner and the change log know them. The name is looked up once per request. */
async function who(req) {
    if (!req.datasetActor) req.datasetActor = { accountId: req.session.accountId, name: await actorName(req) };
    return req.datasetActor;
}

/**
 * Runs fn while this admin holds operation locks on the items it touches. Another admin's lock (or claim) on any of them
 * makes this a 409 { code: 'locked', lockedBy: [...] } and fn never runs. The locks are given back when fn ends. An empty
 * key list just runs fn. The lease outlives the slowest ML call, so it cannot lapse in the middle of an operation.
 */
async function locked(req, lockKeys, purpose, fn, seconds) {
    if (!lockKeys || lockKeys.length === 0) return fn();
    const actor = await who(req);
    const lease = seconds || Math.max(settings.dataset.sync.opLockSeconds, Math.ceil(settings.ml.timeoutMs / 1000) + 15);
    return datasetSync.withLocks(lockKeys, { accountId: actor.accountId, name: actor.name, purpose, seconds: lease }, fn);
}

/** Writes the change-log row and moves the counters for a change that was made. Never fails the request. */
async function track(req, changeInfo) {
    const actor = await who(req);
    return datasetSync.track({ ...changeInfo, accountId: actor.accountId, actorName: actor.name });
}

/**
 * What to lock for work on one plant's scan contributions. A plant's photos are locked as the plant. The unassigned ones
 * (the Other plant inbox) have no plant, so each photo is locked on its own: two admins can file different batches at once.
 */
function ownerLockKeys(plantId, imageIds) {
    if (plantId === trainingPhotos.UNASSIGNED) return datasetSync.keysFor('photo', imageIds);
    return typeof plantId === 'string' && PLANT_ID.test(plantId) ? [datasetSync.keys.plant(plantId)] : [];
}

/**
 * The species (label) folders the given photos are filed in, as the ML service knows them. Photos that are gone are left out
 * (the ML call that follows reports them); Non plant folders are not species and are left out too.
 */
async function speciesOf(pids) {
    const out = await ml('/labels', { method: 'POST', body: { pids } });
    const labels = [];
    for (const entry of Object.values((out && out.labels) || {})) {
        if (entry && datasetSync.LOCKABLE_KINDS.includes(entry.kind) && typeof entry.label === 'string') labels.push(entry.label);
    }
    return [...new Set(labels)];
}

/**
 * locked(), plus the species locks of the named species. Another admin's species lock is a 409 that names the species
 * ("Ben has locked "Aloe vera"..."); this admin's own lock never stops them.
 */
async function lockedInSpecies(req, lockKeys, speciesNames, purpose, fn) {
    const sp = datasetSync.labelKeys(speciesNames);
    try {
        return await locked(req, [...lockKeys, ...sp.keys], purpose, fn);
    } catch (err) {
        if (err instanceof datasetSync.LockedError) err.withLabels(sp.byKey);
        throw err;
    }
}

/** Another admin's lasting lock on this species ({ name, accountId }), or null. A lock that cannot be read is no lock. */
async function otherAdminsSpeciesLock(accountId, label) {
    try {
        const key = datasetSync.keys.label(label);
        const owner = (await datasetSync.readClaims()).find((o) => o.accountId !== accountId && o.keys.includes(key));
        return owner ? { name: owner.name || 'Another admin', accountId: owner.accountId } : null;
    } catch (err) {
        return null;
    }
}

/** The dataset's own spelling of a species or Other plant folder name, or null when there is no such folder. */
async function knownSpecies(name) {
    const wanted = name.toLowerCase();
    const d = await ml('/destinations');
    const labels = [...((d.labels && d.labels.species) || []), ...((d.labels && d.labels.other_plant) || [])];
    return labels.find((l) => typeof l === 'string' && l.toLowerCase() === wanted) || null;
}

/**
 * Adds the species lock key to what a listing returns, so the page can show who has locked a species without knowing how keys
 * are made: `spKey` on each photo and each species folder tile, `labelKey` for the folder the admin is inside.
 */
const lockableKind = (kind) => datasetSync.LOCKABLE_KINDS.includes(kind);
function withSpeciesKeys(out, { kind, label } = {}) {
    if (!out || typeof out !== 'object') return out;
    if (out.level === 'label' && lockableKind(kind) && Array.isArray(out.folders)) {
        out.folders.forEach((f) => { if (typeof f.value === 'string') f.spKey = datasetSync.keys.label(f.value); });
    }
    if (label && lockableKind(kind)) out.labelKey = datasetSync.keys.label(label);
    (Array.isArray(out.photos) ? out.photos : []).forEach((p) => {
        if (p && lockableKind(p.kind) && typeof p.label === 'string') p.spKey = datasetSync.keys.label(p.label);
    });
    return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The last audit as the page needs it. It carries the SERVER's clock and the "recent" window, so "4 minutes ago" and the
 * amber "just ran" state are the same for every admin whatever their own computer's clock says.
 */
const withClock = (status) => ({ ...status, serverNow: new Date().toISOString(), recentMinutes: settings.dataset.auditRecentMinutes });

router.get('/api/dataset/overview', view, handle(async (req, res) => {
    const [overview, status] = await Promise.all([ml('/overview'), ml('/status')]);
    res.json({ ...overview, run: withClock(status) });
}));

router.get('/api/dataset/status', view, handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(withClock(await ml('/status')));
}));

/**
 * "Did anything change?" The answer is decided from the counters alone: the ETag is made from them, so a page that sends it
 * back gets a bodyless 304 and nothing else is read. Only when a counter moved is the change log and the claim list read.
 * Polling this every few seconds is therefore cheap; the interval is settings.dataset.sync.pollSeconds and is sent to the page.
 */
router.get('/api/dataset/sync', view, handle(async (req, res) => {
    let counters;
    try {
        counters = await datasetSync.readCounters();
    } catch (err) {
        // The tables are not there yet (npm run db:migrate): the page keeps working, it just has no live updates.
        res.setHeader('Cache-Control', 'no-store');
        return res.status(503).json({ error: 'Live updates are not set up yet. Run npm run db:migrate.', degraded: true });
    }
    const etag = datasetSync.etagOf(counters);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (datasetSync.etagMatches(req.get('If-None-Match'), etag)) return res.status(304).end();
    res.json(await datasetSync.readSync(req.session.accountId, counters));
}));

/**
 * Marks items as "I am working on this" for the open page, or renews the mark (the page calls it again every third of the
 * lease). Body: { keys: ['photo:pimg_000012', 'pid:...'], purpose? }. Free items are marked; items another admin already holds are
 * returned in `conflicts` with who. A claim is a courtesy marker that also blocks other admins' changes to the same items.
 */
router.post('/api/dataset/locks', change, handle(async (req, res) => {
    const cfg = settings.dataset.sync;
    const wanted = req.body && Array.isArray(req.body.keys) ? req.body.keys : null;
    if (!wanted || wanted.length === 0) return res.status(400).json({ error: 'Nothing to mark' });
    if (wanted.length > cfg.claimMaxKeys) return res.status(400).json({ error: `Mark at most ${cfg.claimMaxKeys} items at a time` });
    // Species locks have their own route (locks/species): it checks the species exists and how many one admin may hold.
    if (!wanted.every((k) => typeof k === 'string' && k !== 'snapshot' && !datasetSync.isSpeciesKey(k) && datasetSync.KEY.test(k))) return res.status(400).json({ error: 'Bad request' });
    const actor = await who(req);
    try {
        const out = await datasetSync.acquire(wanted, {
            accountId: actor.accountId, name: actor.name, purpose: text(req.body.purpose, 32) || 'editing',
            kind: 'claim', seconds: cfg.claimLockSeconds, partial: true
        });
        res.json({ ok: true, held: out.held, conflicts: out.conflicts, leaseSeconds: cfg.claimLockSeconds });
    } catch (err) {
        // A marker is a courtesy: if the table is missing or the database blinks, say so quietly instead of an error page.
        console.warn('Dataset claim failed:', err.message);
        res.json({ ok: true, degraded: true, held: [], conflicts: [], leaseSeconds: cfg.claimLockSeconds });
    }
}));

/** Lets go of this admin's claims. Body: { keys: [...] } or { all: true }. Only ever touches the caller's own rows. */
router.post('/api/dataset/locks/release', view, handle(async (req, res) => {
    const body = req.body || {};
    const target = body.all === true ? 'all' : (Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === 'string') : []);
    try {
        res.json({ ok: true, released: await datasetSync.releaseClaims(req.session.accountId, target) });
    } catch (err) {
        console.warn('Dataset claim release failed:', err.message);
        res.json({ ok: true, released: 0, degraded: true });
    }
}));

/**
 * Locks a whole species folder for this admin: its photos in train, val and test (and Other plant photos filed under the same
 * name) cannot be moved, removed or grouped by anyone else, and nobody else can move photos into it. Body: { label }.
 * Free: locked, or renewed when this admin already holds it. Held by another admin: 409 { code: 'locked', lockedBy } and nothing
 * changes. There is no override, not even for a superadmin. An admin holds at most speciesLockMax species at a time.
 */
router.post('/api/dataset/locks/species', change, handle(async (req, res) => {
    const cfg = settings.dataset.sync;
    const asked = text(req.body && req.body.label, 120);
    if (!asked) return res.status(400).json({ error: 'Choose a species folder to lock' });
    const label = await knownSpecies(asked);
    if (!label) return res.status(404).json({ error: 'That species is not in the dataset' });
    const key = datasetSync.keys.label(label);
    const actor = await who(req);
    try {
        const mine = (await datasetSync.readClaims()).find((o) => o.accountId === actor.accountId);
        const held = mine ? mine.keys.filter(datasetSync.isSpeciesKey) : [];
        if (!held.includes(key) && held.length >= cfg.speciesLockMax) {
            return res.status(409).json({
                error: `You already hold ${held.length} species locks, the most one admin may hold. Unlock one first.`, code: 'too_many_locks'
            });
        }
        await datasetSync.acquire([key], {
            accountId: actor.accountId, name: actor.name, purpose: 'species', kind: 'claim', seconds: cfg.speciesLockSeconds
        });
    } catch (err) {
        if (err instanceof datasetSync.LockedError) throw err.withLabels(new Map([[key, label]]));
        console.warn('Species lock failed:', err.message);
        return res.status(503).json({ error: 'Locking is not available right now. Run npm run db:migrate if this is a new install.' });
    }
    res.json({ ok: true, key, label, leaseSeconds: cfg.speciesLockSeconds });
}));

/** The open page's heartbeat for the species locks it holds. Body: { keys }. Says which of them are still this admin's. */
router.post('/api/dataset/locks/species/renew', change, handle(async (req, res) => {
    const wanted = req.body && Array.isArray(req.body.keys) ? req.body.keys : null;
    if (!wanted || wanted.length === 0 || wanted.length > 50 ||
        !wanted.every((k) => typeof k === 'string' && datasetSync.isSpeciesKey(k) && datasetSync.KEY.test(k))) {
        return res.status(400).json({ error: 'Bad request' });
    }
    const cfg = settings.dataset.sync;
    let held;
    try {
        held = await datasetSync.renewSpeciesLocks(req.session.accountId, wanted, cfg.speciesLockSeconds);
    } catch (err) {
        // Not an answer about the locks: the page keeps what it has and asks again at the next beat.
        console.warn('Species lock renewal failed:', err.message);
        return res.status(503).json({ error: 'Could not renew the lock just now' });
    }
    res.json({ ok: true, held, lost: wanted.filter((k) => !held.includes(k)), leaseSeconds: cfg.speciesLockSeconds });
}));

router.get('/api/dataset/clusters', view, handle(async (req, res) => {
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : '';
    const out = await ml('/clusters' + query({
        category, reviewed: req.query.reviewed === '1' ? 1 : 0,
        page: intIn(req.query.page, 1, 1, 10000), size: intIn(req.query.pageSize, 10, 1, 30)
    }));
    // Each photo of a set says which species lock applies to it, so a card can show "Ben has locked this species".
    (Array.isArray(out.clusters) ? out.clusters : []).forEach((c) => withSpeciesKeys({ photos: c.members }));
    res.json(out);
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
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : '';
    const label = text(req.query.label, 120);
    const out = await ml('/folder' + query({
        split: SPLITS.includes(req.query.split) ? req.query.split : '', kind,
        label, part: text(req.query.part, 40), source: text(req.query.source, 200),
        page: intIn(req.query.page, 1, 1, 10000), size: intIn(req.query.pageSize, 24, 1, 60)
    }));
    res.json(withSpeciesKeys(out, { kind, label }));
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

/** The signed-in admin's username, so the other admins can see who started the audit. Never blocks the audit. */
async function actorName(req) {
    try {
        const [rows] = await db().query('SELECT username FROM accounts WHERE accountId = ?', [req.session.accountId]);
        return rows[0] && rows[0].username ? String(rows[0].username).slice(0, 64) : 'An admin';
    } catch (err) {
        return 'An admin';
    }
}

/**
 * Starts an audit. When the last audit ended less than DATASET_AUDIT_RECENT_MINUTES ago (default 10) the answer is a 409
 * with code 'recent_audit' and who/when, and nothing starts until the page asks again with { confirm: true }. That is
 * checked here, from the ML service's record of the last run, so a page that is minutes out of date is covered too.
 */
router.post('/api/dataset/audit', change, handle(async (req, res) => {
    const recent = datasetAudit.recentAudit(await ml('/status'));
    const confirmed = Boolean(req.body) && req.body.confirm === true;
    if (recent && !confirmed) {
        return res.status(409).json({ error: datasetAudit.recentMessage(recent), code: 'recent_audit', lastRun: recent });
    }
    const out = await ml('/audit', { method: 'POST', body: { by: await actorName(req) } });
    await audit(req, { action: 'audit_started', confirmedRecent: Boolean(recent) });
    res.status(202).json(out);
}));

/** The quick settings of the audit: the model that compares the photos and the two similarity thresholds. */
router.get('/api/dataset/audit-settings', view, handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await ml('/audit-settings'));
}));

/** Body: any of { embedder, cosSimilar, cosSame }. The ML service validates; the new values apply from the next audit. */
router.put('/api/dataset/audit-settings', change, handle(async (req, res) => {
    const body = req.body || {};
    const values = {};
    if (body.embedder !== undefined) values.embedder = text(body.embedder, 80);
    if (body.cosSimilar !== undefined) values.cosSimilar = body.cosSimilar;
    if (body.cosSame !== undefined) values.cosSame = body.cosSame;
    if (Object.keys(values).length === 0) return res.status(400).json({ error: 'Nothing to change' });
    const out = await ml('/audit-settings', { method: 'PUT', body: values });
    await audit(req, { action: 'audit_settings_changed', ...values });
    await track(req, { scopes: ['audit'], action: 'audit_settings_changed', entityType: 'setting', summary: 'changed the audit settings' });
    res.json(out);
}));

router.post('/api/dataset/review', change, handle(async (req, res) => {
    const { clusterId, decision } = req.body || {};
    if (!CLUSTER.test(clusterId || '') || !['kept', 'removed'].includes(decision)) return res.status(400).json({ error: 'Bad request' });
    await locked(req, [datasetSync.keys.cluster(clusterId)], 'reviewing', async () => {
        await ml('/review', { method: 'POST', body: { clusterId, decision } });
        await audit(req, { action: 'cluster_reviewed', clusterId, decision });
    });
    await track(req, {
        scopes: ['folder'], action: 'cluster_reviewed', entityType: 'cluster', entityIds: [clusterId], count: 1,
        summary: decision === 'kept' ? 'marked a duplicate set as not a problem' : 'marked a duplicate set as handled'
    });
    res.json({ ok: true });
}));

/** Moves photos to the quarantine folder. Nothing is deleted. */
router.post('/api/dataset/remove', change, handle(async (req, res) => {
    const pids = pidList(req.body && req.body.pids);
    if (!pids) return res.status(400).json({ error: 'Pick between 1 and 50 photos' });
    const note = text(req.body.note, 200) || 'removed from the dataset';
    const clusterId = req.body.clusterId;
    const lockKeys = datasetSync.keysFor('pid', pids);
    if (CLUSTER.test(clusterId || '')) lockKeys.push(datasetSync.keys.cluster(clusterId));
    const out = await lockedInSpecies(req, lockKeys, await speciesOf(pids), 'removing', async () => {
        const result = await ml('/quarantine', { method: 'POST', body: { pids, note } });
        if (CLUSTER.test(clusterId || '')) await ml('/review', { method: 'POST', body: { clusterId, decision: 'removed' } });
        await audit(req, { action: 'photos_quarantined', moved: result.moved, missing: (result.missing || []).length, clusterId: clusterId || null, note });
        return result;
    });
    await track(req, {
        scopes: ['folder'], action: 'photos_quarantined', entityType: 'photo', entityIds: pids, count: out.moved,
        summary: `removed ${photosN(out.moved)} from the dataset`
    });
    res.json(out);
}));

router.post('/api/dataset/restore', change, handle(async (req, res) => {
    const qid = req.body && req.body.qid;
    if (!PID.test(qid || '')) return res.status(400).json({ error: 'Bad request' });
    // A photo goes back into the species it was removed from, so that species' lock applies.
    const removed = ((await ml('/quarantine')).items || []).find((item) => item.qid === qid);
    const out = await lockedInSpecies(req, [datasetSync.keys.quarantine(qid)], removed && removed.label ? [removed.label] : [], 'restoring', async () => {
        const result = await ml('/restore', { method: 'POST', body: { qid } });
        await audit(req, { action: 'photo_restored', qid });
        return result;
    });
    await track(req, { scopes: ['folder'], action: 'photo_restored', entityType: 'quarantine', entityIds: [qid], count: 1, summary: 'put a removed photo back' });
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
    // Moving photos INTO a species another admin has locked is allowed, but only after a warning the admin confirms: it is mostly
    // harmless, and sometimes it is the point (an admin found a leak and puts the photo in its correct species). Moving photos
    // OUT of a locked species, removing and grouping stay refused. The confirmation is checked here, not just on the page.
    const destHolder = dest.label && datasetSync.LOCKABLE_KINDS.includes(dest.kind)
        ? await otherAdminsSpeciesLock(req.session.accountId, dest.label) : null;
    if (destHolder && !preview && body.confirmLocked !== true) {
        return res.status(409).json({
            error: `${destHolder.name} has locked "${dest.label}" and may be working in it right now. Moving photos in can disturb their work. Move them anyway?`,
            code: 'dest_locked', lockedBy: [{ name: destHolder.name }]
        });
    }
    // A preview changes nothing, so it takes no lock. A move touches two species: where the photos are now and where they go
    // (the destination only when nobody has locked it: a confirmed move into a locked species does not take their lock).
    const touched = preview ? [] : [...await speciesOf(pids), ...(dest.label && datasetSync.LOCKABLE_KINDS.includes(dest.kind) && !destHolder ? [dest.label] : [])];
    const out = await lockedInSpecies(req, preview ? [] : datasetSync.keysFor('pid', pids), touched, 'moving', async () => {
        const result = await ml('/move', { method: 'POST', body: { pids, dest, preview } });
        if (!preview) await audit(req, { action: 'photos_moved', moved: result.moved, to: result.to, warnings: (result.warnings || []).length });
        return result;
    });
    if (!preview) {
        const to = out.to && typeof out.to === 'object' ? [out.to.split, out.to.kind, out.to.label, out.to.part].filter(Boolean).join(' / ') : '';
        await track(req, {
            scopes: ['folder'], action: 'photos_moved', entityType: 'photo', entityIds: pids, count: out.moved,
            summary: `moved ${photosN(out.moved)}${to ? ` to ${to}` : ''}`
        });
    }
    if (preview && destHolder) {
        out.destLocked = { name: destHolder.name, label: dest.label };
        out.warnings = [`${destHolder.name} has locked "${dest.label}" and may be working in it right now. Moving photos in can disturb their work.`, ...(out.warnings || [])];
    }
    res.json(out);
}));

/** These photos must always land in the same split. */
router.post('/api/dataset/group', change, handle(async (req, res) => {
    const pids = pidList(req.body && req.body.pids);
    if (!pids || pids.length < 2) return res.status(400).json({ error: 'Pick at least two photos' });
    const clusterId = req.body.clusterId;
    const lockKeys = datasetSync.keysFor('pid', pids);
    if (CLUSTER.test(clusterId || '')) lockKeys.push(datasetSync.keys.cluster(clusterId));
    const out = await lockedInSpecies(req, lockKeys, await speciesOf(pids), 'grouping', async () => {
        const result = await ml('/group', { method: 'POST', body: { pids } });
        if (CLUSTER.test(clusterId || '')) await ml('/review', { method: 'POST', body: { clusterId, decision: 'kept' } });
        await audit(req, { action: 'photos_grouped', group: result.group, photos: result.photos, clusterId: clusterId || null });
        return result;
    });
    await track(req, {
        scopes: ['folder'], action: 'photos_grouped', entityType: 'photo', entityIds: pids, count: pids.length,
        summary: `kept ${photosN(pids.length)} together in one split`
    });
    res.json(out);
}));

/** A new part row, optionally with its folders for one species. */
router.post('/api/dataset/parts', change, handle(async (req, res) => {
    const part = text(req.body && req.body.part, 40);
    const species = text(req.body && req.body.species, 120);
    if (!part) return res.status(400).json({ error: 'A part name is required' });
    const out = await ml('/parts', { method: 'POST', body: { part, species } });
    await audit(req, { action: 'part_added', part: out.part, species: species || null, folders: out.created.length });
    await track(req, { scopes: ['folder'], action: 'part_added', entityType: 'part', count: 1, summary: `added the part "${String(out.part || part).slice(0, 40)}"` });
    res.json(out);
}));

/** Records the decision to promote a species. The next retrain, not this, makes scans identify it. */
router.post('/api/dataset/species/promote', change, handle(async (req, res) => {
    const plantId = req.body && req.body.plantId;
    if (typeof plantId !== 'string' || !PLANT_ID.test(plantId)) return res.status(400).json({ error: 'Bad request' });
    const out = await locked(req, [datasetSync.keys.species(plantId)], 'promoting', async () => species.promoteSpecies(db(), {
        plantId, accountId: req.session.accountId, note: text(req.body.note, 255), classes: await species.loadActiveClassSet()
    }));
    if (out.changed) {
        await audit(req, { action: 'species_promoted', plantId, scientificName: out.species.scientificName, uniquePhotos: out.species.uniquePhotos });
        await track(req, { scopes: ['species'], action: 'species_promoted', entityType: 'species', entityIds: [plantId], count: 1, summary: `promoted ${out.species.scientificName}` });
    }
    res.json(out);
}));

/** Takes a promotion back, while the active model does not list the species yet. */
router.post('/api/dataset/species/unpromote', change, handle(async (req, res) => {
    const plantId = req.body && req.body.plantId;
    if (typeof plantId !== 'string' || !PLANT_ID.test(plantId)) return res.status(400).json({ error: 'Bad request' });
    const out = await locked(req, [datasetSync.keys.species(plantId)], 'promoting', async () => species.undoPromotion(db(), {
        plantId, accountId: req.session.accountId, note: text(req.body.note, 255), classes: await species.loadActiveClassSet()
    }));
    await audit(req, { action: 'species_unpromoted', plantId, scientificName: out.species.scientificName });
    await track(req, { scopes: ['species'], action: 'species_unpromoted', entityType: 'species', entityIds: [plantId], count: 1, summary: `took back the promotion of ${out.species.scientificName}` });
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
    sendResult(res, await trainingPhotos.listTrainingPhotos(req.params.plantId, undefined, { countsOnly: Boolean(req.query) && req.query.counts === '1' }));
}));

/**
 * Body: { imageIds: [...], trainingStatus?, trainingReason?, part?, groupKey? }
 *   or: { allCandidates: true, trainingStatus: 'included' | 'excluded', part? }  (decides every candidate at once)
 */
router.post('/api/plants/:plantId/training', change, handle(async (req, res) => {
    const body = req.body || {};
    const { plantId } = req.params;
    // The whole plant is locked: "decide every candidate" touches photos the request does not name.
    const result = await locked(req, PLANT_ID.test(plantId) ? [datasetSync.keys.plant(plantId)] : [], 'editing', async () => (
        body.allCandidates === true
            ? trainingPhotos.decideCandidates(plantId, body.trainingStatus, body.part)
            : trainingPhotos.setTraining(plantId, body.imageIds, body)
    ));
    if (!result.error) {
        const trainingStatus = result.trainingStatus || (result.patch && result.patch.trainingStatus) || null;
        await audit(req, {
            action: 'training_changed', plantId, photos: result.changed,
            trainingStatus,
            part: result.patch && 'part' in result.patch ? result.patch.part : undefined,
            groupChanged: Boolean(result.patch && 'groupKey' in result.patch)
        });
        await track(req, {
            scopes: ['training'], action: 'training_changed', entityType: 'photo',
            entityIds: body.allCandidates === true ? [] : (Array.isArray(body.imageIds) ? body.imageIds : []), count: result.changed,
            summary: trainingStatus
                ? `marked ${photosN(result.changed)} as ${trainingStatus}`
                : `updated the part or group of ${photosN(result.changed)}`
        });
    }
    sendResult(res, result);
}));

// ---- scan contributions grouped by the plant they are assigned to (the "Scan contributions" section of the plants page)

/** One page of plants that have contributions, with their counts. ?review=1: only plants with a photo still waiting. */
router.get('/api/dataset/db/contributions/groups', view, handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await trainingPhotos.listContributionGroups(undefined, {
        page: req.query.page, review: req.query.review === '1'
    })) });
}));

/** One page of one plant's contributions. The page size is the admin's "photos per page" setting, never the caller's. */
router.get('/api/dataset/db/contributions/:plantId/photos', view, handle(async (req, res) => {
    const pageSize = await require('../config/setting-mysql').getAdminPhotoPageSize();
    res.setHeader('Cache-Control', 'no-store');
    sendResult(res, await trainingPhotos.listContributionPhotos(req.params.plantId, undefined, {
        page: req.query.page, review: req.query.review === '1', pageSize
    }));
}));

/** Body: { fromPlantId, toPlantId, imageIds }. */
router.post('/api/dataset/db/contributions/move', change, handle(async (req, res) => {
    const body = req.body || {};
    const result = await locked(req, ownerLockKeys(body.fromPlantId, body.imageIds), 'moving', async () => (
        trainingPhotos.moveContributions(body.fromPlantId, body.toPlantId, body.imageIds)
    ));
    if (!result.error) {
        await audit(req, {
            action: 'contributions_moved', from: result.fromPlantId, to: result.toPlantId,
            photos: result.moved, resetToCandidate: result.resetToCandidate
        });
        await track(req, {
            scopes: ['training', 'species'], action: 'contributions_moved', entityType: 'photo', entityIds: body.imageIds, count: result.moved,
            summary: `moved ${photosN(result.moved)} to another plant`
        });
    }
    sendResult(res, result);
}));

/** Body: { plantId, imageIds, part? }: includes the photos that are still candidates. */
router.post('/api/dataset/db/contributions/include', change, handle(async (req, res) => {
    const body = req.body || {};
    const result = await locked(req, ownerLockKeys(body.plantId, body.imageIds), 'including', async () => (
        trainingPhotos.includeContributions(body.plantId, body.imageIds, body.part)
    ));
    if (!result.error) {
        await audit(req, {
            action: 'contributions_included', plantId: result.plantId, photos: result.included,
            leftAlone: result.leftAlone, part: body.part || null
        });
        await track(req, {
            scopes: ['training'], action: 'contributions_included', entityType: 'photo', entityIds: body.imageIds, count: result.included,
            summary: `included ${photosN(result.included)} in the dataset`
        });
    }
    sendResult(res, result);
}));

/** Body: { plantId, imageIds, reason? }: keeps the photos out of the dataset. plantId may be "_unassigned". */
router.post('/api/dataset/db/contributions/exclude', change, handle(async (req, res) => {
    const body = req.body || {};
    const result = await locked(req, ownerLockKeys(body.plantId, body.imageIds), 'excluding', async () => (
        trainingPhotos.excludeContributions(body.plantId, body.imageIds, body.reason)
    ));
    if (!result.error) {
        await audit(req, { action: 'contributions_excluded', plantId: result.plantId, photos: result.excluded });
        await track(req, {
            scopes: ['training'], action: 'contributions_excluded', entityType: 'photo', entityIds: body.imageIds, count: result.excluded,
            summary: `excluded ${photosN(result.excluded)} from the dataset`
        });
    }
    sendResult(res, result);
}));

/** Active plants matching ?q= (at least 2 characters), for the "move to" picker. */
router.get('/api/dataset/db/plant-search', view, handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendResult(res, await trainingPhotos.searchPlants(req.query.q));
}));

// ---- the Other plant inbox: scan contributions with no plant yet (the "Other plant" section of the Database view)

/** The filters the inbox list and its "all matching" ids share. Bad values are ignored by listUnassigned, never trusted. */
const inboxFilters = (q) => ({
    review: q.review === '1', sort: q.sort, minConfidence: q.min, maxConfidence: q.max,
    modelId: typeof q.modelId === 'string' && q.modelId ? q.modelId : undefined
});

/** One page of the inbox. The page size is the admin's "photos per page" setting, never the caller's. */
router.get('/api/dataset/db/other-plant', view, handle(async (req, res) => {
    const pageSize = await require('../config/setting-mysql').getAdminPhotoPageSize();
    res.setHeader('Cache-Control', 'no-store');
    sendResult(res, await trainingPhotos.listUnassigned({ db: db() }, { ...inboxFilters(req.query), page: req.query.page, pageSize }));
}));

/** Every photo id the filter matches (at most DATASET_MAX_BULK_MOVE), so the page can select all of them at once. */
router.get('/api/dataset/db/other-plant/ids', view, handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendResult(res, await trainingPhotos.listUnassigned({ db: db() }, { ...inboxFilters(req.query), idsOnly: true }));
}));

/** Body: { toPlantId, imageIds, include?, part? }. Answers with where the plant now stands for promotion. */
router.post('/api/dataset/db/other-plant/assign', change, handle(async (req, res) => {
    const body = req.body || {};
    const result = await locked(req, datasetSync.keysFor('photo', body.imageIds), 'filing', async () => otherPlant.assign({
        toPlantId: body.toPlantId, imageIds: body.imageIds, include: body.include === true, part: text(body.part, 40)
    }, { db: db() }));
    if (!result.error) {
        await audit(req, {
            action: 'other_plant_assigned', to: result.toPlantId, photos: result.moved,
            included: result.included, leftForReview: result.leftForReview
        });
        await track(req, {
            scopes: ['training', 'species'], action: 'other_plant_assigned', entityType: 'photo', entityIds: body.imageIds, count: result.moved,
            summary: `filed ${photosN(result.moved)} from the Other plant inbox under ${result.plant && result.plant.scientificName ? result.plant.scientificName : 'a plant'}`
        });
    }
    sendResult(res, result);
}));

/** Body: { imageIds, topK? }. Needs the ML service; embeds what it has not seen yet (a bounded number per call). */
router.post('/api/dataset/db/other-plant/suggest', view, handle(async (req, res) => {
    const body = req.body || {};
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await otherPlant.suggest({ imageIds: body.imageIds, topK: body.topK }, { db: db() })) });
}));

/** Body: { imageIds?, threshold?, topK? }. imageIds left out: the newest waiting photos. */
router.post('/api/dataset/db/other-plant/groups', view, handle(async (req, res) => {
    const body = req.body || {};
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await otherPlant.groups({ imageIds: body.imageIds, threshold: body.threshold, topK: body.topK }, { db: db() })) });
}));

router.get('/api/dataset/db/other-plant/embedders', view, handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await otherPlant.embedders()) });
}));

/** Body: { kind: 'mobilenet' | 'saved' | 'model:<id>' }. The ML service loads it first, so a broken choice is refused here. */
router.post('/api/dataset/db/other-plant/embedder', change, handle(async (req, res) => {
    const out = await otherPlant.chooseEmbedder(req.body && req.body.kind);
    await audit(req, { action: 'embedder_changed', embedder: out.current, name: out.name });
    await track(req, { scopes: ['audit'], action: 'embedder_changed', entityType: 'setting', summary: `chose ${out.name || out.current || 'another model'} to compare photos` });
    res.json({ ok: true, ...out });
}));

router.get('/api/dataset/db/summary', view, handle(async (req, res) => {
    // The origin is checked by trainingSummary itself (an unknown value is a 400, never "all photos").
    const summary = await trainingPhotos.trainingSummary(undefined, { origin: req.query.origin });
    if (summary.error) return res.status(summary.code || 400).json({ error: summary.error });
    res.json({ ...summary, otherPlantCap: settings.dataset.otherPlantCap });
}));

router.get('/api/dataset/db/snapshots', view, handle(async (req, res) => {
    res.json({ items: await dbSnapshot.listSnapshots() });
}));

router.post('/api/dataset/db/snapshots', change, handle(async (req, res) => {
    // One build at a time: a second admin pressing the button while one runs is told who is building it.
    const result = await locked(req, [datasetSync.keys.snapshot], 'building', () => dbSnapshot.buildSnapshot(), settings.dataset.sync.snapshotLockSeconds);
    if (!result.error) {
        await audit(req, { action: 'db_snapshot_built', snapshot: result.name, photos: result.counts.photos, skipped: result.counts.skipped });
        await track(req, { scopes: ['snapshots'], action: 'db_snapshot_built', entityType: 'snapshot', count: 1, summary: `built snapshot ${result.name} (${photosN(result.counts.photos)})` });
    }
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    // The folder on this computer is not sent to the browser: only its name, which is what the split script takes.
    const { dir, ...rest } = result;
    res.status(201).json(rest);
}));

module.exports = router;
