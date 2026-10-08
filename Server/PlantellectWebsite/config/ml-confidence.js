// config/ml-confidence.js
//
// Turns a prediction list into identified / uncertain / unrecognized.
// Pure functions: no mysql.js, no mongoose, no I/O. The caller reads the
// `mlConfidence` row from system_settings and passes it in, same shape of
// contract as config/approval-mode.js taking an executor.

const MODES = Object.freeze(['off', 'log', 'enforce']);

const OUTCOMES = Object.freeze({
    IDENTIFIED: 'identified',
    UNCERTAIN: 'uncertain',
    UNRECOGNIZED: 'unrecognized'
});

// Placeholders. NOT tuned: measure a held-out set (trained species, untrained
// plants, non-plants) before trusting any of these numbers.
const DEFAULTS = Object.freeze({
    mode: 'off',
    acceptThreshold: 0.70,    // top-1 at/above this (and a clear margin) => identified
    uncertainThreshold: 0.35, // top-1 at/above this => uncertain, below => unrecognized
    marginThreshold: 0.15     // top-1 minus top-2 needed to call it identified
});

const isUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

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
 * Accepts [0.91, 0.05, ...] or [{ confidence: 0.91, ... }, ...] in any order.
 * Adjust the object field name if your /predict response uses another one.
 */
function toScores(predictions) {
    if (!Array.isArray(predictions)) return [];
    return predictions
        .map((p) => (typeof p === 'number' ? p : p && p.confidence))
        .filter((n) => typeof n === 'number' && Number.isFinite(n))
        .map((n) => Math.min(1, Math.max(0, n)))
        .sort((a, b) => b - a); // never trust the incoming order
}

/** The decision itself, ignoring mode. */
function classify(predictions, config) {
    const cfg = resolveConfig(config);
    const [top1 = 0, top2 = 0] = toScores(predictions);
    const margin = top1 - top2;

    let outcome;
    if (top1 >= cfg.acceptThreshold && margin >= cfg.marginThreshold) {
        outcome = OUTCOMES.IDENTIFIED;
    } else if (top1 >= cfg.uncertainThreshold) {
        outcome = OUTCOMES.UNCERTAIN;   // includes: confident but too close to the runner-up
    } else {
        outcome = OUTCOMES.UNRECOGNIZED; // includes: empty or malformed prediction list
    }
    return { outcome, top1, top2, margin };
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

module.exports = { MODES, OUTCOMES, DEFAULTS, validateConfig, resolveConfig, classify, evaluate };