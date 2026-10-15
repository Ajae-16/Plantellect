const express = require('express');
const multer = require('multer');
const { requirePermission } = require('../middleware/authMiddleware');
// NOTE: getSystemSetting is the one name I could not see in your code. Point it at
// whatever your system_settings read helper is called; it must resolve to the
// parsed JSON value of the row (an object, or a JSON string - both handled below).
const { resolveScientificNames, consumeScanQuota, scanWindowRetryAfterSeconds, getSystemSetting } = require('../config/mysql.js');
const { handleUploadError } = require('../config/upload');
const { logMlScan } = require('../mongoose-schemas/Mlscan.js');
const { evaluate, isSpecies } = require('../config/ml-confidence');
const settings = require('../config/settings');
const router = express.Router();

const ML_SERVICE_URL = settings.ml.serviceUrl;

// A margin needs a runner-up, so the service is always asked for at least this
// many predictions even when the client asked for fewer. With non_plant and
// other_plant both possible, 3 guarantees a species rival even when they rank 1 and 2.
const MIN_TOP_K_FOR_VERDICT = 3;
// non_plant and other_plant can occupy this many slots of the list. They are removed
// before the client sees it, so the service is asked for that many EXTRA predictions and
// the client still gets as many species as it asked for. (FastAPI accepts top_k up to 50.)
const NON_SPECIES_SLOTS = 2;
const FASTAPI_MAX_TOP_K = 50;
// In enforce mode, an 'uncertain' scan shows this many "possible matches".
const UNCERTAIN_SHOW = 3;
// system_settings['mlConfidence'] is read per scan but not inside a transaction
// and gates no write, so a short cache is fine (unlike the approval modes).
const ML_CONFIDENCE_TTL_MS = 30 * 1000;

let mlConfidenceCache = { at: 0, value: {} };

/**
 * Returns the mlConfidence entry for one model, keyed by its folder name
 * (efficientnetv2b1, convnexttiny), or null when there is none. Fails OPEN like
 * the quota check: on a read error the last good value is kept and the scan is
 * served normally. A null entry means evaluate() treats the model as mode 'off'.
 */
async function getMlConfidence(modelId) {
    if (Date.now() - mlConfidenceCache.at > ML_CONFIDENCE_TTL_MS) {
        try {
            let value = await getSystemSetting('mlConfidence');
            if (typeof value === 'string') value = JSON.parse(value);
            mlConfidenceCache = { at: Date.now(), value: value || {} };
        } catch (err) {
            console.error('mlConfidence read failed (using last good value):', err.message);
            mlConfidenceCache.at = Date.now(); // back off for one TTL instead of retrying every scan
        }
    }
    return mlConfidenceCache.value[modelId] || null;
}

let activeModelCache = { at: 0, value: '' };

/**
 * Which model folder this scan should use. Precedence:
 *   1. system_settings['mlActiveModel']   runtime, admin-editable ({ "modelId": "..." } or a bare string)
 *   2. settings.ml.defaultModel           ML_DEFAULT_MODEL in .env
 *   3. '' (no header)                     the ML service's own DEFAULT_MODEL_ID
 * A failed read keeps the last good runtime value; with none, falls through to 2.
 */
async function getActiveModelId() {
    if (Date.now() - activeModelCache.at > ML_CONFIDENCE_TTL_MS) {
        try {
            let value = await getSystemSetting('mlActiveModel');
            if (typeof value === 'string') {
                try { value = JSON.parse(value); } catch (_) { /* a bare model id string */ }
            }
            const id = typeof value === 'string' ? value : value && value.modelId;
            activeModelCache = { at: Date.now(), value: typeof id === 'string' ? id.trim() : '' };
        } catch (err) {
            console.error('mlActiveModel read failed (using last good value):', err.message);
            activeModelCache.at = Date.now(); // back off for one TTL
        }
    }
    return activeModelCache.value || settings.ml.defaultModel || '';
}

// Memory storage, because the buffer is forwarded straight to FastAPI. The
// limits are the point: without them any signed-in account (including the
// least-privileged user) could buffer an unbounded multipart body into RAM.
// express.json()'s cap does not apply to multipart.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: settings.ml.maxUploadBytes,
        files: 1
    }
});

let maxTopKCache = { at: 0, value: null };

/**
 * The most predictions one scan may ask for: system_settings['mlRequest'].maxTopK (the admin
 * "ML Request" field), else settings.ml.maxTopK (ML_MAX_TOP_K in .env). Same rules as the other
 * reads: short cache, fails OPEN to the last good value, and an unusable row falls back to settings.js.
 */
async function getMaxTopK() {
    if (Date.now() - maxTopKCache.at > ML_CONFIDENCE_TTL_MS) {
        try {
            let value = await getSystemSetting('mlRequest');
            if (typeof value === 'string') value = JSON.parse(value);
            const n = value ? Number(value.maxTopK) : NaN;
            maxTopKCache = { at: Date.now(), value: Number.isInteger(n) && n >= 1 && n <= 100 ? n : null };
        } catch (err) {
            console.error('mlRequest read failed (using last good value):', err.message);
            maxTopKCache.at = Date.now(); // back off for one TTL
        }
    }
    return maxTopKCache.value || settings.ml.maxTopK;
}

/**
 * Clamps top_k into 1..max instead of forwarding it raw. The ceiling is also kept under what
 * FastAPI accepts minus the slots non_plant / other_plant can take, so the client always gets
 * exactly the number of species it asked for.
 */
function clampTopK(raw, max) {
    const ceiling = Math.max(1, Math.min(max, FASTAPI_MAX_TOP_K - NON_SPECIES_SLOTS));
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return Math.min(5, ceiling);
    return Math.min(Math.max(parsed, 1), ceiling);
}

/**
 * Attaches plantId and imageUrl to each prediction by matching its
 * scientific_name against the plants table. Names with no matching plant are
 * left untouched so a prediction is never dropped just because the library
 * does not know the species yet.
 *
 * Returns { data, linksResolved }. A failed lookup leaves every prediction with
 * no plantId, which would make the whole event look like a library-wide gap —
 * the caller records the flag so the gap feed can exclude those events.
 */
async function attachPlantLinks(data) {
    if (!data || !Array.isArray(data.predictions) || data.predictions.length === 0) {
        return { data, linksResolved: true };
    }
    try {
        const names = data.predictions
            .map((p) => p.scientific_name)
            .filter((n) => typeof n === 'string' && n.length > 0);
        const matches = await resolveScientificNames(names);
        for (let i = 0; i < data.predictions.length; i++) {
            const prediction = data.predictions[i];
            const match = matches.get(prediction.scientific_name);
            prediction.rank = i + 1;
            if (match) {
                prediction.plantId = match.plantId;
                prediction.commonName = match.commonName;
                if (match.heroImageId) {
                    prediction.imageUrl = `/api/plants/${match.plantId}/images/${match.heroImageId}`;
                }
            }
        }
        return { data, linksResolved: true };
    } catch (err) {
        // A lookup failure must not break the prediction itself.
        console.error('Plant link lookup failed:', err.message);
        return { data, linksResolved: false };
    }
}

// Proxy prediction to FastAPI.
//
// Order matters: permission, then quota, then the upstream call, then the log.
// The quota is charged on ATTEMPT, so the 502/504 paths below still consume it
// and a broken ML service cannot be hammered.
router.post('/predict', requirePermission('scan_plant'), upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
    }

    // Fails OPEN: a database blip must not take scanning down, it only means the
    // quota is not enforced for this request. Authorization is unaffected —
    // that already passed above.
    let quota = null;
    try {
        quota = await consumeScanQuota(req.session.accountId, settings.ml.rateLimitWindowMs);
        if (quota.used > settings.ml.rateLimitMax) {
            const retryAfter = scanWindowRetryAfterSeconds(settings.ml.rateLimitWindowMs);
            res.setHeader('Retry-After', String(retryAfter));
            return res.status(429).json({
                error: `Scan limit reached. Try again in ${retryAfter} seconds.`,
                limit: settings.ml.rateLimitMax,
                windowMs: settings.ml.rateLimitWindowMs,
                retryAfter
            });
        }
    } catch (err) {
        console.error('Scan quota check failed (serving unenforced):', err.message);
    }

    const topK = clampTopK(req.body.top_k, await getMaxTopK()); // what the client gets back
    const fetchK = Math.min(Math.max(topK + NON_SPECIES_SLOTS, MIN_TOP_K_FOR_VERDICT), FASTAPI_MAX_TOP_K); // what the service is asked for
    const logBase = {
        accountId: req.session.accountId,
        topK,
        ip: req.ip || '',
        userAgent: req.get('user-agent') || ''
    };

    try {
        const callPredict = async (modelId) => {
            const formData = new FormData();
            formData.append('image', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
            formData.append('top_k', String(fetchK));

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), settings.ml.timeoutMs);
            try {
                const response = await fetch(`${ML_SERVICE_URL}/predict`, {
                    method: 'POST',
                    body: formData,
                    headers: modelId ? { 'x-model-id': modelId } : undefined,
                    signal: controller.signal
                });
                return { response, raw: await response.json() };
            } finally {
                clearTimeout(timeoutId);
            }
        };

        // Runtime setting -> env default -> no header (the service's own default).
        // A 404 means the service does not have that model (typo, folder removed,
        // folder skipped at startup), so move down the chain instead of failing every
        // scan until someone fixes the setting. Any other status is a real answer.
        const activeModelId = await getActiveModelId();
        const candidates = [...new Set([activeModelId, settings.ml.defaultModel].filter(Boolean)), ''];
        let response;
        let raw;
        for (let i = 0; i < candidates.length; i++) {
            ({ response, raw } = await callPredict(candidates[i]));
            if (response.status !== 404 || i === candidates.length - 1) break;
            console.error(`ML model '${candidates[i]}' unavailable, trying '${candidates[i + 1] || 'service default'}'`);
        }

        // Decide from the FULL prediction list. The list is trimmed to topK only for the
        // LOG (so the logged predictions and the gap signal keep their old size) and
        // filtered to species only for the CLIENT, further down. Never throws: a verdict
        // problem must not fail a scan.
        const modelId = (raw && raw.model_id) || '';
        let verdict = null;
        if (response.ok && raw && Array.isArray(raw.predictions)) {
            try {
                verdict = evaluate(raw.predictions, await getMlConfidence(modelId));
            } catch (err) {
                console.error('Confidence evaluation failed (serving unchanged):', err.message);
            }
            raw.top_k = topK;
        }

        // Logged after attachPlantLinks so each prediction carries the plantId
        // that makes the species-gap signal possible.
        const { data, linksResolved } = await attachPlantLinks(raw);
        await logMlScan({
            ...logBase,
            status: response.ok ? 'ok' : 'error',
            modelId,
            modelVersion: (data && data.model_version) || '',
            inferenceMs: (data && data.inference_ms) ?? null,
            linksResolved,
            // null while mode is 'off'. In 'log' mode this is recorded but never shown.
            verdict: verdict && {
                mode: verdict.mode,
                outcome: verdict.outcome,
                top1: verdict.top1,
                top2: verdict.top2,
                margin: verdict.margin,
                applied: verdict.apply,
                thresholds: verdict.thresholds,
                reason: verdict.reason,
                topKind: verdict.topKind
            },
            // The real top-K as the model ranked it, non-species classes included (kind says which).
            predictions: Array.isArray(data && data.predictions)
                ? data.predictions.slice(0, topK).map((p) => ({
                    scientificName: p.scientific_name || '',
                    commonName: p.commonName || p.common_name || '',   // attachPlantLinks sets commonName
                    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
                    plantId: p.plantId || null,
                    rank: p.rank ?? null,
                    kind: p.kind || 'species'
                }))
                : []
        });

        // What the client sees: never a non_plant / other_plant class as if it were a species,
        // in any mode, and as many species as were asked for. top_kind tells the UI what the
        // model's best guess was. Done AFTER logging so the log keeps the real list.
        if (data && Array.isArray(data.predictions)) {
            data.top_kind = (data.predictions[0] && data.predictions[0].kind) || 'species';
            data.predictions = data.predictions.filter(isSpecies).slice(0, topK);
            data.predictions.forEach((p, i) => { p.rank = i + 1; });
        }
        // FastAPI errors carry { detail }; ml-client.js reads { error }.
        if (!response.ok && data && data.detail && !data.error) {
            data.error = typeof data.detail === 'string' ? data.detail : 'Prediction failed';
        }

        // Only 'enforce' changes what the client sees. Done AFTER logging so the
        // log keeps the real predictions even when they are withheld here.
        if (verdict && verdict.apply && data) {
            data.outcome = verdict.outcome;
            data.reason = verdict.reason;
            if (verdict.outcome === 'unrecognized') {
                data.predictions = [];
            } else if (verdict.outcome === 'uncertain') {
                data.predictions = data.predictions.slice(0, UNCERTAIN_SHOW);
            }
        }

        res.status(response.status).json(data);
    } catch (err) {
        // Failures are logged too, so the feed can show failure rates.
        await logMlScan({ ...logBase, status: 'error', linksResolved: false, predictions: [] });
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'ML service timeout' });
        }
        console.error('ML proxy error:', err);
        res.status(502).json({ error: 'ML service unavailable' });
    }
});

router.get('/model/info', requirePermission('scan_plant'), async (req, res) => {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), settings.ml.timeoutMs);

        try {
            const activeModelId = await getActiveModelId();
            let response = await fetch(`${ML_SERVICE_URL}/model/info`, {
                headers: activeModelId ? { 'x-model-id': activeModelId } : undefined,
                signal: controller.signal
            });
            // An unknown active model must not hide available_models from the admin.
            if (response.status === 404 && activeModelId) {
                response = await fetch(`${ML_SERVICE_URL}/model/info`, { signal: controller.signal });
            }
            const data = await response.json();
            res.status(response.status).json(data);
        } finally {
            clearTimeout(timeoutId);
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'ML service timeout' });
        }
        res.status(502).json({ error: 'ML service unavailable' });
    }
});

// Must stay last: turns a rejected upload into a 400 naming the limit.
router.use(handleUploadError({
    maxSizeBytes: settings.ml.maxUploadBytes,
    maxFilesPerRequest: 1,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp']
}));

module.exports = router;
