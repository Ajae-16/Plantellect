const express = require('express');
const multer = require('multer');
const { requirePermission } = require('../middleware/authMiddleware');
// NOTE: getSystemSetting is the one name I could not see in your code. Point it at
// whatever your system_settings read helper is called; it must resolve to the
// parsed JSON value of the row (an object, or a JSON string - both handled below).
const { resolveScientificNames, consumeScanQuota, scanWindowRetryAfterSeconds, getSystemSetting } = require('../config/mysql.js');
const { handleUploadError } = require('../config/upload');
const { logMlScan } = require('../mongoose-schemas/Mlscan.js');
const { evaluate } = require('../config/ml-confidence');
const settings = require('../config/settings');
const router = express.Router();

const ML_SERVICE_URL = settings.ml.serviceUrl;

// A margin needs a runner-up, so the service is always asked for at least this
// many predictions even when the client asked for fewer. The client still gets
// exactly the number it asked for back.
const MIN_TOP_K_FOR_VERDICT = 3;
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

/** Clamps top_k into 1..settings.ml.maxTopK instead of forwarding it raw. */
function clampTopK(raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return Math.min(5, settings.ml.maxTopK);
    return Math.min(Math.max(parsed, 1), settings.ml.maxTopK);
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

    const topK = clampTopK(req.body.top_k);            // what the client gets back
    const fetchK = Math.max(topK, MIN_TOP_K_FOR_VERDICT); // what the service is asked for
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

        // Decide from the FULL prediction list, then trim to what was asked for,
        // so the logged predictions and the gap signal are exactly what they were
        // before this change. Never throws: a verdict problem must not fail a scan.
        const modelId = (raw && raw.model_id) || '';
        let verdict = null;
        if (response.ok && raw && Array.isArray(raw.predictions)) {
            try {
                verdict = evaluate(raw.predictions, await getMlConfidence(modelId));
            } catch (err) {
                console.error('Confidence evaluation failed (serving unchanged):', err.message);
            }
            raw.predictions = raw.predictions.slice(0, topK);
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
                thresholds: verdict.thresholds
            },
            predictions: Array.isArray(data && data.predictions)
                ? data.predictions.map((p) => ({
                    scientificName: p.scientific_name || '',
                    commonName: p.common_name || '',
                    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
                    plantId: p.plantId || null,
                    rank: p.rank ?? null
                }))
                : []
        });

        // Only 'enforce' changes what the client sees. Done AFTER logging so the
        // log keeps the real predictions even when they are withheld here.
        if (verdict && verdict.apply && data) {
            data.outcome = verdict.outcome;
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