// config/ml-confidence.js
//
// Turns a prediction list into identified / uncertain / unrecognized.
// Pure functions: no mysql.js, no mongoose, no I/O. The caller reads the
// `mlConfidence` row from system_settings and passes it in, same shape of
// contract as config/approval-mode.js taking an executor.
//
// CLASS-AWARE: a prediction may carry `kind` ('species' | 'non_plant' | 'other_plant'),
// which FastAPI copies from classes.json. A missing kind means 'species', so models
// trained before those classes existed behave exactly as before.

const MODES = Object.freeze(['off', 'log', 'enforce']);

const OUTCOMES = Object.freeze({
    IDENTIFIED: 'identified',
    UNCERTAIN: 'uncertain',
    UNRECOGNIZED: 'unrecognized'
});

// WHY the outcome happened. The outcome set above is unchanged on purpose, so
// anything that already stores or switches on it keeps working.
const REASONS = Object.freeze({
    SPECIES: 'species',               // identified a supported species
    NON_PLANT: 'non_plant',           // "No plant detected"
    OTHER_PLANT: 'other_plant',       // "Plant detected, but species is not supported"
    LOW_CONFIDENCE: 'low_confidence', // top-1 too weak to name anything
    CLOSE_CALL: 'close_call'          // confident, but too close to the runner-up
});

const NON_SPECIES_KINDS = Object.freeze(['non_plant', 'other_plant']);

// Placeholders. NOT tuned: measure a held-out set (trained species, untrained
// plants, non-plants) before trusting any of these numbers.
const DEFAULTS = Object.freeze({
    mode: 'off',
    acceptThreshold: 0.70,    // top-1 at/above this (and a clear margin) => identified
    uncertainThreshold: 0.35, // top-1 at/above this => uncertain, below => unrecognized
    marginThreshold: 0.15     // top-1 minus top-2 needed to call it identified
});

const isUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** True for anything that may be shown to a user as a species name. */
function isSpecies(prediction) {
    const kind = prediction && typeof prediction === 'object' ? prediction.kind : undefined;
    return !NON_SPECIES_KINDS.includes(kind);
}

/**
 * Validate a config object (use on admin write). Returns { ok, errors, value }.
 * Unknown keys are rejected so a typo cannot silently do nothing.
 */
function validateConfig(input) {
    const errors = [];
    const cfg = { ...DEFAULTS, ...(input || {}) };

    for (const key of Object.keys(input || {})) {
        if (!(key in DEFAULTS)) errors.push(`Unknown key: ${key}`);
    }
    if (!MODES.includes(cfg.mode)) errors.push(`mode must be one of: ${MODES.join(', ')}`);
    for (const key of ['acceptThreshold', 'uncertainThreshold', 'marginThreshold']) {
        if (!isUnit(cfg[key])) errors.push(`${key} must be a number between 0 and 1`);
    }
    if (isUnit(cfg.acceptThreshold) && isUnit(cfg.uncertainThreshold)
        && cfg.uncertainThreshold >= cfg.acceptThreshold) {
        errors.push('uncertainThreshold must be lower than acceptThreshold');
    }
    return { ok: errors.length === 0, errors, value: cfg };
}

/**
 * Merge a stored row over the defaults. A bad row falls back to DEFAULTS
 * (mode 'off') instead of throwing, so a corrupt setting can never break a scan.
 */
function resolveConfig(stored) {
    const result = validateConfig(stored);
    return result.ok ? result.value : { ...DEFAULTS };
}

/**
 * Accepts [0.91, 0.05, ...] or [{ confidence: 0.91, kind: 'species', ... }, ...]
 * in any order. Returns [{ confidence, kind }] sorted high to low. Bare numbers
 * (and objects without a kind) count as species.
 */
function toRanked(predictions) {
    if (!Array.isArray(predictions)) return [];
    return predictions
        .map((p) => ({
            confidence: typeof p === 'number' ? p : p && p.confidence,
            kind: isSpecies(p) ? 'species' : p.kind
        }))
        .filter((p) => typeof p.confidence === 'number' && Number.isFinite(p.confidence))
        .map((p) => ({ ...p, confidence: Math.min(1, Math.max(0, p.confidence)) }))
        .sort((a, b) => b.confidence - a.confidence); // never trust the incoming order
}

/** The decision itself, ignoring mode. */
function classify(predictions, config) {
    const cfg = resolveConfig(config);
    const ranked = toRanked(predictions);
    const top1 = ranked.length > 0 ? ranked[0].confidence : 0;
    const top2 = ranked.length > 1 ? ranked[1].confidence : 0;
    const topKind = ranked.length > 0 ? ranked[0].kind : 'species';
    // Margin = how far top-1 leads the answer it actually competes with.
    //  - a species answer competes with whatever is second (another species, or a non-species class);
    //  - a non_plant / other_plant answer competes only with SPECIES. Those two classes both mean
    //    "no supported species", so a narrow gap between them is not a close call.
    // top2 stays the raw second-highest score, for logging.
    const rival = topKind === 'species' ? ranked[1] : ranked.slice(1).find((p) => p.kind === 'species');
    const margin = top1 - (rival ? rival.confidence : 0);

    let outcome;
    let reason;
    if (top1 < cfg.uncertainThreshold) {
        // includes: empty or malformed prediction list
        outcome = OUTCOMES.UNRECOGNIZED;
        reason = REASONS.LOW_CONFIDENCE;
    } else if (topKind !== 'species') {
        // The model's best guess is "not a plant" or "a plant we do not support".
        // Say so only when it clearly beats the runner-up; a narrow win is a coin flip.
        if (margin >= cfg.marginThreshold) {
            outcome = OUTCOMES.UNRECOGNIZED;
            reason = topKind;
        } else {
            outcome = OUTCOMES.UNCERTAIN;
            reason = REASONS.CLOSE_CALL;
        }
    } else if (top1 >= cfg.acceptThreshold && margin >= cfg.marginThreshold) {
        outcome = OUTCOMES.IDENTIFIED;
        reason = REASONS.SPECIES;
    } else {
        outcome = OUTCOMES.UNCERTAIN;
        reason = top1 >= cfg.acceptThreshold ? REASONS.CLOSE_CALL : REASONS.LOW_CONFIDENCE;
    }
    return { outcome, reason, topKind, top1, top2, margin };
}

/**
 * What the route calls.
 *   off     -> null (nothing to log, behaviour unchanged)
 *   log     -> decision to record in mlscans; `apply` is false, show the user nothing new
 *   enforce -> same decision, `apply` true: change what the user sees
 */
function evaluate(predictions, config) {
    const cfg = resolveConfig(config);
    if (cfg.mode === 'off') return null;

    const decision = classify(predictions, cfg);
    return {
        mode: cfg.mode,
        apply: cfg.mode === 'enforce',
        ...decision,
        thresholds: {
            accept: cfg.acceptThreshold,
            uncertain: cfg.uncertainThreshold,
            margin: cfg.marginThreshold
        }
    };
}

module.exports = {
    MODES, OUTCOMES, REASONS, NON_SPECIES_KINDS, DEFAULTS,
    validateConfig, resolveConfig, classify, evaluate, isSpecies
};