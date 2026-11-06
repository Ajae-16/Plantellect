// config/contribute-offer.js
//
// Scan contributions,  decides whether a scan may be offered for training, and signs the
// offer. Pure functions: no mysql.js, no mongoose, no I/O, no clock of its own (`now` is passed in),
// so every rule can be tested on its own.
//
// An offer is a short-lived HMAC token. NOTHING IS STORED. The token carries what the server saw
// at scan time (account, plant, confidence, model, SHA-256 of the image bytes, expiry), so when
// the browser later posts the photo back  the server can check it against the token
// instead of trusting anything the browser says. The browser never supplies a confidence number.

const crypto = require('crypto');
const { OUTCOMES, isSpecies, contributeSettings } = require('./ml-confidence');

const TOKEN_VERSION = 1;
const OFFER_TTL_MS = 15 * 60 * 1000;
// Domain separation: the signing key is derived from the session secret for this one purpose, so a
// token can never be confused with (or forged from) anything else signed with that secret.
const KEY_LABEL = 'plantellect:ml-contribute-offer:v1';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function deriveKey(secret) {
    if (typeof secret !== 'string' || secret.length === 0) throw new Error('A signing secret is required');
    return crypto.createHmac('sha256', secret).update(KEY_LABEL).digest();
}

function sign(payloadB64, secret) {
    return crypto.createHmac('sha256', deriveKey(secret)).update(payloadB64).digest();
}

/** SHA-256 (hex) of the image bytes the browser uploaded to /predict. */
function hashImage(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Whether this scan may be offered for contribution. Every condition must hold:
 *   1. contributeMode is 'on' for the model
 *   2. the verdict exists and was ENFORCED (mode 'enforce'; off and log never offer)
 *   3. the outcome is 'identified'
 *   4. the top class is a species, OR it is 'other_plant' and contributeOtherPlants is on (never non_plant)
 *   5. a species must be in the library (it has a plantId); an other_plant has no plant, so its offer
 *      carries plantId null and kind 'other_plant' and the photo is filed unassigned
 *   6. top-1 is inside the contribute band: at or above contributeThreshold (lower) and at or below
 *      contributeUpperThreshold (upper), both ends included, e.g. 85% to 95%
 *   7. the model id is known (the token must name it)
 *
 * `predictions` is the list as the model ranked it, after plant links were attached, BEFORE the
 * client-facing filtering. Returns { eligible, reason, ... }; reason says which rule failed.
 */
function evaluateOffer({ verdict, predictions, modelId, mlConfig }) {
    const cfg = contributeSettings(mlConfig);
    if (!cfg.on) return { eligible: false, reason: 'contribute_off' };
    if (!verdict) return { eligible: false, reason: 'no_verdict' };
    if (!verdict.apply || verdict.mode !== 'enforce') return { eligible: false, reason: 'not_enforced' };
    const otherPlant = cfg.otherPlants && verdict.outcome === OUTCOMES.UNRECOGNIZED && verdict.reason === 'other_plant';
    if (verdict.outcome !== OUTCOMES.IDENTIFIED && !otherPlant) return { eligible: false, reason: 'not_identified' };

    // The highest-confidence entry, whatever order the list came in (same rule as ml-confidence.js).
    const top = Array.isArray(predictions)
        ? [...predictions].filter((p) => p && typeof p.confidence === 'number').sort((a, b) => b.confidence - a.confidence)[0]
        : null;
    if (!top) return { eligible: false, reason: 'not_species' };
    // The verdict says the best guess was "other plant"; the top entry must agree, so a stale verdict cannot offer a species photo as unassigned.
    const kind = otherPlant ? 'other_plant' : 'species';
    if (otherPlant ? top.kind !== 'other_plant' : !isSpecies(top)) return { eligible: false, reason: 'not_species' };
    if (kind === 'species' && (typeof top.plantId !== 'string' || top.plantId === '')) return { eligible: false, reason: 'no_plant' };

    const confidence = top.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < cfg.threshold) {
        return { eligible: false, reason: 'below_threshold' };
    }
    if (confidence > cfg.upperThreshold) return { eligible: false, reason: 'above_threshold' };
    if (typeof modelId !== 'string' || modelId === '') return { eligible: false, reason: 'no_model' };

    return { eligible: true, reason: 'ok', kind, plantId: kind === 'species' ? top.plantId : null, confidence, modelId };
}

/**
 * Signs an offer. Returns { token, expiresAt } where expiresAt is epoch milliseconds.
 * Token = base64url(JSON payload) + '.' + base64url(HMAC-SHA256 of that first part).
 */
function signOffer({ accountId, plantId, kind, confidence, modelId, imageSha256 }, { secret, now = Date.now(), ttlMs = OFFER_TTL_MS }) {
    const exp = now + ttlMs;
    // k is only written for an other-plant offer, so a species token is byte-for-byte what it always was.
    const payload = b64u(JSON.stringify({
        v: TOKEN_VERSION, a: accountId, p: plantId, ...(kind === 'other_plant' ? { k: 'other_plant' } : {}),
        c: confidence, m: modelId, h: imageSha256, exp
    }));
    return { token: `${payload}.${b64u(sign(payload, secret))}`, expiresAt: exp };
}

/**
 * Checks a token. `accountId` and `imageSha256` come from the CURRENT request (the session and
 * the bytes just uploaded), never from the token. Returns { ok: true, offer } or
 * { ok: false, reason } with reason one of: malformed, unsupported_version, bad_signature,
 * expired, wrong_account, wrong_image.
 */
function verifyOffer(token, { secret, accountId, imageSha256, now = Date.now() }) {
    if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };

    // Signature first, so nothing below runs on a payload that was not signed by us.
    const given = Buffer.from(parts[1], 'base64url');
    const expected = sign(parts[0], secret);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return { ok: false, reason: 'bad_signature' };
    }

    let p;
    try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (_) { return { ok: false, reason: 'malformed' }; }
    if (!p || typeof p !== 'object') return { ok: false, reason: 'malformed' };
    if (p.v !== TOKEN_VERSION) return { ok: false, reason: 'unsupported_version' };
    if (typeof p.exp !== 'number' || now >= p.exp) return { ok: false, reason: 'expired' };
    if (typeof accountId !== 'string' || p.a !== accountId) return { ok: false, reason: 'wrong_account' };
    if (typeof imageSha256 !== 'string' || p.h !== imageSha256) return { ok: false, reason: 'wrong_image' };

    return {
        ok: true,
        offer: { accountId: p.a, plantId: p.p, kind: p.k === 'other_plant' ? 'other_plant' : 'species', confidence: p.c, modelId: p.m, imageSha256: p.h, expiresAt: p.exp }
    };
}

/**
 * What /predict calls. Returns { token, expiresAt, plantId, confidence } or null. Never throws:
 * a problem here must not fail a scan, it only means no offer is made. The image is hashed only
 * when the scan is eligible, so an ordinary scan costs nothing extra.
 */
function createOffer({ verdict, predictions, modelId, mlConfig, accountId, imageBuffer, secret, now }) {
    try {
        if (!secret || !accountId || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) return null;
        const decision = evaluateOffer({ verdict, predictions, modelId, mlConfig });
        if (!decision.eligible) return null;
        const signed = signOffer({
            accountId,
            plantId: decision.plantId,
            kind: decision.kind,
            confidence: decision.confidence,
            modelId: decision.modelId,
            imageSha256: hashImage(imageBuffer)
        }, { secret, now });
        return { ...signed, plantId: decision.plantId, kind: decision.kind, confidence: decision.confidence };
    } catch (err) {
        console.error('Contribute offer failed (no offer made):', err.message);
        return null;
    }
}

module.exports = { OFFER_TTL_MS, TOKEN_VERSION, hashImage, evaluateOffer, signOffer, verifyOffer, createOffer };
