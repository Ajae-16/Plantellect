// "Looks like photo X": a hint shown to the reviewer at approval (dataset handler plan,
// stage 7a).
//
// For each pending photo of a request it looks for approved photos it resembles:
//
//   1. Perceptual hash (dHash), against EVERY approved photo of every plant. Cheap, needs
//      no ML service, and catches the same photo under two species, which is the
//      highest-priority leak in the plan. Also compares the pending photos of the
//      request with each other (a duplicate inside one submission).
//   2. MobileNet embeddings from the FastAPI container (POST /lookalike/compare), against
//      the approved photos of the plant the request is about (newest first, capped).
//      Catches a same-shot copy or a burst frame that a hash misses. When the service is
//      down or only has its weak fallback embedder, this half is skipped and the answer
//      says so; the hash half still works.
//
// A hint never blocks an approval and nothing here writes to the database or the disk.
// Photo pixels are shrunk and sent to the ML service and dropped; no metadata is read.
// The thresholds are starting values (config/settings.js, `lookalike`), not calibrated.

const fs = require('fs');
const settings = require('./settings');
const publicImages = require('./public-images');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[0-9a-f]{16}$/;

/** Number of differing bits between two 16-hex-digit dHashes, or null when either is not one. */
function hamming(a, b) {
    if (!HASH.test(String(a || '')) || !HASH.test(String(b || ''))) return null;
    let x = BigInt('0x' + a) ^ BigInt('0x' + b);
    let bits = 0;
    while (x > 0n) { bits += Number(x & 1n); x >>= 1n; }
    return bits;
}

const previewUrl = (imageId) => `/admin/api/plant-images/${encodeURIComponent(imageId)}`;

/** Shrinks a master to a small JPEG for the ML service. Orientation only; no metadata is kept. */
async function shrinkMaster(file) {
    const sharp = require('sharp');
    const edge = settings.lookalike.sendLongEdge;
    return sharp(file, { limitInputPixels: settings.ingest.maxInputPixels, failOn: 'warning' })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
}

/** Asks the ML service to compare. Returns { available, reason?, matches } and never throws. */
async function embeddingMatches(candidates, references, deps) {
    const cfg = settings.lookalike;
    if (candidates.length === 0 || references.length === 0) return { available: true, matches: {} };
    const fetchImpl = deps.fetchImpl || fetch;
    const shrink = deps.shrink || shrinkMaster;
    const read = deps.masterFile || ((row) => publicImages.masterFileOf(row.storedPath));
    try {
        const form = new FormData();
        let sent = 0;
        for (const [field, rows] of [['candidates', candidates], ['references', references]]) {
            for (const row of rows) {
                const file = read(row);
                if (!file || !fs.existsSync(file)) continue;
                form.append(field, new Blob([await shrink(file)], { type: 'image/jpeg' }), `${row.imageId}.jpg`);
                sent++;
            }
        }
        if (sent === 0) return { available: false, reason: 'no_files', matches: {} };
        form.append('min_similarity', String(cfg.similarSimilarity));

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
        let response;
        try {
            response = await fetchImpl(`${settings.ml.serviceUrl}/lookalike/compare`, {
                method: 'POST', body: form, signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) return { available: false, reason: 'service_error', matches: {} };
        const body = await response.json();
        // The weak fallback embedder says nothing about leaves: ignore it rather than mislead.
        if (body.degraded) return { available: false, reason: 'degraded', matches: {} };
        return { available: true, matches: body.matches || {} };
    } catch (err) {
        return { available: false, reason: 'service_down', matches: {} };
    }
}

const RANK = { near_copy: 0, same_shot: 1, similar: 2 };

/**
 * Hints for the pending photos of one request.
 * Returns { requestId, targetPlantId, embedding: { available, reason? }, photos: { [imageId]: [hint] } }
 * where a hint is { imageId, plantId, plantName, kind: 'near_copy' | 'same_shot' | 'similar',
 *                   source: 'hash' | 'embedding', distance?, similarity?, sameSubmission, url }.
 */
async function findLookalikes(requestId, deps = {}) {
    if (!SAFE_ID.test(String(requestId || ''))) return { error: 'That is not a valid request id', code: 400 };
    const db = deps.db || require('./pool-mysql').mysqlPool;
    const cfg = settings.lookalike;

    const [requests] = await db.query(
        'SELECT requestId, status, targetPlantId, payload FROM approval_requests WHERE requestId = ?',
        [requestId]
    );
    if (requests.length === 0) return { error: 'Request not found', code: 404 };
    const request = requests[0];
    let payload = {};
    try { payload = typeof request.payload === 'string' ? JSON.parse(request.payload) : (request.payload || {}); } catch (err) { payload = {}; }
    const imageIds = (Array.isArray(payload.imageIds) ? payload.imageIds : []).filter((id) => SAFE_ID.test(String(id)));
    const result = {
        requestId, targetPlantId: request.targetPlantId || null,
        embedding: { available: true }, photos: {}
    };
    if (request.status !== 'pending' || imageIds.length === 0) return result;

    const [candidates] = await db.query(
        `SELECT imageId, storedPath, perceptualHash FROM plant_images
         WHERE imageId IN (${imageIds.map(() => '?').join(',')}) AND status = 'pending'`,
        imageIds
    );
    candidates.forEach((c) => { result.photos[c.imageId] = []; });
    if (candidates.length === 0) return result;

    const hints = new Map();   // candidate imageId -> Map(other imageId -> hint)
    const add = (candidateId, hint) => {
        const perPhoto = hints.get(candidateId) || new Map();
        const old = perPhoto.get(hint.imageId);
        if (!old || RANK[hint.kind] < RANK[old.kind] ||
            (RANK[hint.kind] === RANK[old.kind] && (hint.similarity || 0) > (old.similarity || 0))) {
            perPhoto.set(hint.imageId, hint);
        }
        hints.set(candidateId, perPhoto);
    };

    // 1a. Hashes against every approved photo.
    const [pool] = await db.query(
        `SELECT i.imageId, i.plantId, i.perceptualHash, p.commonName, p.scientificName
         FROM plant_images i JOIN plants p ON p.plantId = i.plantId
         WHERE i.status = 'approved' AND i.perceptualHash IS NOT NULL
         ORDER BY i.uploadedAt DESC LIMIT ?`,
        [cfg.hashPoolCap]
    );
    for (const c of candidates) {
        for (const a of pool) {
            const d = hamming(c.perceptualHash, a.perceptualHash);
            if (d !== null && d <= cfg.hashMaxDistance) {
                add(c.imageId, {
                    imageId: a.imageId, plantId: a.plantId, plantName: a.commonName || a.scientificName,
                    kind: 'near_copy', source: 'hash', distance: d, sameSubmission: false, url: previewUrl(a.imageId)
                });
            }
        }
        // 1b. The other photos in the same submission.
        for (const o of candidates) {
            if (o.imageId === c.imageId) continue;
            const d = hamming(c.perceptualHash, o.perceptualHash);
            if (d !== null && d <= cfg.hashMaxDistance) {
                add(c.imageId, {
                    imageId: o.imageId, plantId: request.targetPlantId || null, plantName: null,
                    kind: 'near_copy', source: 'hash', distance: d, sameSubmission: true, url: previewUrl(o.imageId)
                });
            }
        }
    }

    // 2. Embeddings against the target plant's approved photos.
    if (request.targetPlantId && cfg.embeddingReferenceCap > 0) {
        const [references] = await db.query(
            `SELECT imageId, plantId, storedPath FROM plant_images
             WHERE plantId = ? AND status = 'approved'
             ORDER BY uploadedAt DESC LIMIT ?`,
            [request.targetPlantId, cfg.embeddingReferenceCap]
        );
        const [plantRows] = await db.query('SELECT commonName, scientificName FROM plants WHERE plantId = ?', [request.targetPlantId]);
        const plantName = plantRows[0] ? (plantRows[0].commonName || plantRows[0].scientificName) : null;
        const outcome = await embeddingMatches(candidates, references, deps);
        result.embedding = outcome.available ? { available: true } : { available: false, reason: outcome.reason };
        for (const [candidateId, matches] of Object.entries(outcome.matches)) {
            for (const m of matches) {
                if (m.similarity < cfg.similarSimilarity) continue;
                add(candidateId, {
                    imageId: m.id, plantId: request.targetPlantId, plantName,
                    kind: m.similarity >= cfg.sameShotSimilarity ? 'same_shot' : 'similar',
                    source: 'embedding', similarity: m.similarity, sameSubmission: false, url: previewUrl(m.id)
                });
            }
        }
    } else {
        // A new species has no photos of its own to compare with; only the hash check applies.
        result.embedding = { available: false, reason: request.targetPlantId ? 'disabled' : 'new_species' };
    }

    for (const [candidateId, perPhoto] of hints) {
        result.photos[candidateId] = [...perPhoto.values()]
            .sort((x, y) => RANK[x.kind] - RANK[y.kind] || (y.similarity || 0) - (x.similarity || 0) || (x.distance || 0) - (y.distance || 0))
            .slice(0, cfg.maxHintsPerPhoto);
    }
    return result;
}

module.exports = { findLookalikes, hamming, embeddingMatches };
