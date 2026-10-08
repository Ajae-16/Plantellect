const settings = require('./settings');

/**
 * Single resolver for ALL settings: role_limits -> system_settings -> settings.js
 * Validates per field, clamps to range, logs substitutions, never returns 0/NaN
 * roleId is OPTIONAL: per-role callers pass it; global callers (approval-mode, discovery flags) omit it
 *
 * Precedence: role_limits (per role, only if roleId provided) -> system_settings (global) -> settings.js (default)
 * Per-field validation: bad field falls through to default FOR THAT FIELD ONLY
 */

// Default values from settings.js (fallback layer)
const SETTINGS_DEFAULTS = {
    discoveries: {
        maxClaimsPerBotanist: settings.discoveries.maxClaimsPerBotanist,
        maxOpenReportsPerAccount: settings.discoveries.maxOpenReportsPerAccount,
        cancelGraceHours: settings.discoveries.cancelGraceHours,
        reportCooldownMinutes: settings.discoveries.reportCooldownMinutes,
        claimStaleDays: settings.discoveries.claimStaleDays,
        notAPlantVotes: settings.discoveries.notAPlantVotes,
        discoveryClosedPhotoDays: settings.discoveries.discoveryClosedPhotoDays
    },
    mlRequest: {
        maxTopK: settings.ml.maxTopK
    },
    mlConfidence: {
        // This will be populated by seed, but provide safe fallbacks
        efficientnetv2b1: { mode: 'off', acceptThreshold: 0.70, uncertainThreshold: 0.35, marginThreshold: 0.15 },
        convnexttiny: { mode: 'off', acceptThreshold: 0.70, uncertainThreshold: 0.35, marginThreshold: 0.15 }
    },
    mlActiveModel: {
        modelId: settings.ml.defaultModel || 'efficientnetv2b1'
    }
};

// Role-specific defaults (used when role_limits has no row)
const ROLE_DEFAULTS = {
    user: {
        maxOpenReportsPerAccount: settings.discoveries.maxOpenReportsPerAccount,
        rateLimitMax: settings.ml.rateLimitMax
    },
    botanist: {
        maxClaimsPerBotanist: settings.discoveries.maxClaimsPerBotanist,
        maxOpenReportsPerAccount: settings.discoveries.maxOpenReportsPerAccount,
        rateLimitMax: settings.ml.rateLimitMax
    },
    admin: {
        maxClaimsPerBotanist: settings.discoveries.maxClaimsPerBotanist,
        maxOpenReportsPerAccount: settings.discoveries.maxOpenReportsPerAccount,
        rateLimitMax: settings.ml.rateLimitMax
    },
    superadmin: {
        maxClaimsPerBotanist: settings.discoveries.maxClaimsPerBotanist,
        maxOpenReportsPerAccount: settings.discoveries.maxOpenReportsPerAccount,
        rateLimitMax: settings.ml.rateLimitMax
    }
};

/**
 * Validates and clamps a numeric value, logging any substitution
 * Returns the validated/clamped value, or null if invalid (triggers fallback)
 */
function validateNumber(value, key, min, max, source) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        console.warn(`limits: ${source}.${key} is not a valid number (got ${JSON.stringify(value)}), falling back`);
        return null;
    }
    if (value < min || value > max) {
        const clamped = Math.max(min, Math.min(max, value));
        console.warn(`limits: ${source}.${key} = ${value} out of range [${min}, ${max}], clamped to ${clamped}`);
        return clamped;
    }
    return value;
}

/**
 * Validates an object's fields against a schema
 * Returns { valid: true, value: validatedObject } or { valid: false, value: partialValidatedObject }
 * Per-field validation: good fields are kept, bad fields are omitted (fall through to next tier)
 */
function validateObject(obj, schema, source) {
    if (!obj || typeof obj !== 'object') return { valid: false, value: {} };
    const result = {};
    let anyValid = false;
    for (const [field, rules] of Object.entries(schema)) {
        const raw = obj[field];
        let validated = raw;
        if (rules.type === 'number') {
            validated = validateNumber(raw, field, rules.min, rules.max, `${source}.${field}`);
        } else if (rules.type === 'string') {
            if (typeof raw !== 'string' || raw === '') {
                console.warn(`limits: ${source}.${field} is not a valid string, falling back`);
                validated = null;
            }
        } else if (rules.type === 'object') {
            if (!raw || typeof raw !== 'object') {
                console.warn(`limits: ${source}.${field} is not a valid object, falling back`);
                validated = null;
            }
        }
        if (validated !== null) {
            result[field] = validated;
            anyValid = true;
        }
    }
    return { valid: anyValid, value: result };
}

// Schemas for validation
const DISCOVERIES_SCHEMA = {
    maxClaimsPerBotanist: { type: 'number', min: 1, max: 1000 },
    maxOpenReportsPerAccount: { type: 'number', min: 1, max: 1000 },
    cancelGraceHours: { type: 'number', min: 0, max: 8760 }, // up to 1 year
    reportCooldownMinutes: { type: 'number', min: 0, max: 10080 }, // up to 1 week
    claimStaleDays: { type: 'number', min: 1, max: 365 },
    notAPlantVotes: { type: 'number', min: 2, max: 100 }, // floor of 2 enforced elsewhere too
    discoveryClosedPhotoDays: { type: 'number', min: 1, max: 365 }
};

const ML_REQUEST_SCHEMA = {
    maxTopK: { type: 'number', min: 1, max: 100 }
};

const ML_CONFIDENCE_SCHEMA = {
    // Per-model validation happens dynamically
};

const ML_ACTIVE_MODEL_SCHEMA = {
    modelId: { type: 'string' }
};

/**
 * Gets a setting value from system_settings
 * Returns the parsed JSON value or null if not found
 */
async function getSystemSettingValue(conn, key) {
    const [rows] = await conn.query(
        'SELECT settingValue FROM system_settings WHERE settingKey = ?',
        [key]
    );
    if (rows.length === 0) return null;
    const val = rows[0].settingValue;
    if (typeof val === 'string') {
        try {
            return JSON.parse(val);
        } catch (e) {
            console.warn(`limits: system_settings.${key} is invalid JSON, falling back`);
            return null;
        }
    }
    return val;
}

/**
 * Gets a role limit value from role_limits
 * Returns the parsed JSON value or null if not found
 */
async function getRoleLimitValue(conn, roleId, limitKey) {
    const [rows] = await conn.query(
        'SELECT limitValue FROM role_limits WHERE roleId = ? AND limitKey = ?',
        [roleId, limitKey]
    );
    if (rows.length === 0) return null;
    const val = rows[0].limitValue;
    if (typeof val === 'string') {
        try {
            return JSON.parse(val);
        } catch (e) {
            console.warn(`limits: role_limits.${roleId}.${limitKey} is invalid JSON, falling back`);
            return null;
        }
    }
    return val;
}

/**
 * Gets role name from roleId
 */
async function getRoleName(conn, roleId) {
    const [rows] = await conn.query('SELECT roleName FROM roles WHERE roleId = ?', [roleId]);
    return rows[0]?.roleName || null;
}

/**
 * Main resolver: role_limits -> system_settings -> settings.js
 * roleId is optional: when provided, checks role_limits first
 * Returns the validated value (never 0/NaN for numeric fields)
 */
async function resolveSetting(conn, key, roleId = null) {
    // If roleId provided, check role_limits first
    if (roleId) {
        const roleName = await getRoleName(conn, roleId);
        if (roleName && ROLE_DEFAULTS[roleName] && ROLE_DEFAULTS[roleName][key] !== undefined) {
            const roleLimitVal = await getRoleLimitValue(conn, roleId, key);
            if (roleLimitVal !== null) {
                // Validate per field
                const validated = validateNumber(roleLimitVal, key, 1, 10000, `role_limits.${roleId}`);
                if (validated !== null) return validated;
            }
        }
    }

    // Check system_settings
    const sysVal = await getSystemSettingValue(conn, key);
    if (sysVal !== null) {
        let schema;
        if (key === 'discoveries') schema = DISCOVERIES_SCHEMA;
        else if (key === 'mlRequest') schema = ML_REQUEST_SCHEMA;
        else if (key === 'mlConfidence') schema = ML_CONFIDENCE_SCHEMA;
        else if (key === 'mlActiveModel') schema = ML_ACTIVE_MODEL_SCHEMA;

        if (schema) {
            const { valid, value } = validateObject(sysVal, schema, `system_settings.${key}`);
            if (valid) {
                // Return the validated object, merging with defaults for any missing fields
                const defaults = SETTINGS_DEFAULTS[key] || {};
                return { ...defaults, ...value };
            }
        } else {
            // No schema - for simple values (number, string, boolean), return directly
            // For objects, validate they're proper objects
            if (typeof sysVal === 'object' && sysVal !== null) {
                return sysVal;
            }
            // Simple value (number, string, boolean) - return as-is
            return sysVal;
        }
    }

    // Fallback to settings.js defaults
    return SETTINGS_DEFAULTS[key] || null;
}

/**
 * Alias for resolveSetting when roleId is REQUIRED (quota/spam limits)
 * Used by: consumeScanQuota, claimDiscovery, createDiscoveryReport
 */
async function resolveLimit(conn, limitKey, roleId) {
    if (!roleId) {
        throw new Error('resolveLimit requires roleId');
    }
    return resolveSetting(conn, limitKey, roleId);
}

module.exports = {
    resolveSetting,
    resolveLimit,
    SETTINGS_DEFAULTS,
    ROLE_DEFAULTS
};