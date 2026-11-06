// The two admin-editable numbers behind the description votes, stored in system_settings under
// the key `descriptionVotes` (JSON: { upvoteAlert, downvoteHide }) like every other setting.
//
// Precedence: system_settings row -> settings.descriptionVotes (env-seeded default). A bad or
// missing value falls back PER FIELD, and a failing read falls back to the defaults instead of
// breaking voting: a vote must never fail because the settings table hiccuped.
//
// Not in config/limits.js on purpose: that resolver is keyed to role limits and the discovery
// schema, and these two numbers have nothing to do with either.

const { mysqlPool } = require('./pool-mysql');
const settings = require('./settings');

const KEY = 'descriptionVotes';

// downvoteHide has a floor of 2 so one account can never hide someone else's work alone.
const LIMITS = {
    upvoteAlert: { min: 1, max: 1000 },
    downvoteHide: { min: 2, max: 1000 }
};

function defaults() {
    return {
        upvoteAlert: settings.descriptionVotes.upvoteAlert,
        downvoteHide: settings.descriptionVotes.downvoteHide
    };
}

/** Validates the fields that were SENT. Returns { value } (only those fields) or { error }. */
function validateVoteSettings(input) {
    const body = input && typeof input === 'object' ? input : {};
    const value = {};
    for (const [field, { min, max }] of Object.entries(LIMITS)) {
        if (body[field] === undefined) continue;
        const raw = body[field];
        const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
        if (String(raw).trim() === '' || !Number.isInteger(n) || n < min || n > max) {
            return { error: `${field} must be a whole number from ${min} to ${max}` };
        }
        value[field] = n;
    }
    if (Object.keys(value).length === 0) return { error: 'Nothing to save' };
    return { value };
}

function parseStored(raw) {
    if (raw == null) return {};
    if (typeof raw === 'string') {
        try { return JSON.parse(raw) || {}; } catch (err) { return {}; }
    }
    return typeof raw === 'object' ? raw : {};
}

/** The numbers in force right now: { upvoteAlert, downvoteHide, version, stored }. */
async function getVoteSettings(executor = mysqlPool) {
    const out = { ...defaults(), version: 0, stored: false };
    try {
        const [rows] = await executor.query(
            'SELECT settingValue, version FROM system_settings WHERE settingKey = ?',
            [KEY]
        );
        if (!rows || rows.length === 0) return out;
        const saved = parseStored(rows[0].settingValue);
        for (const [field, { min, max }] of Object.entries(LIMITS)) {
            const n = Number(saved[field]);
            if (Number.isInteger(n) && n >= min && n <= max) out[field] = n;
        }
        out.version = Number(rows[0].version) || 0;
        out.stored = true;
    } catch (err) {
        console.warn('description-vote-settings: using defaults,', err.message);
    }
    return out;
}

/**
 * Saves the sent fields. `version` (optional) is the version the editor loaded: when it no longer
 * matches, nothing is written and the caller gets a 409, so two admins cannot silently overwrite
 * each other (same idea as the other settings endpoints).
 */
async function saveVoteSettings(input, accountId, version) {
    const checked = validateVoteSettings(input);
    if (checked.error) return { error: checked.error, code: 400 };

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            'SELECT settingValue, version FROM system_settings WHERE settingKey = ? FOR UPDATE',
            [KEY]
        );
        const current = rows.length ? Number(rows[0].version) : 0;
        if (version !== undefined && version !== null && Number(version) !== current) {
            await conn.rollback();
            return { error: 'Someone else changed these settings. Reload and try again.', code: 409 };
        }
        const merged = { ...defaults(), ...parseStored(rows.length ? rows[0].settingValue : null), ...checked.value };
        // Never store a pair that contradicts itself with a stale half.
        const finalCheck = validateVoteSettings(merged);
        if (finalCheck.error) {
            await conn.rollback();
            return { error: finalCheck.error, code: 400 };
        }
        await conn.query(
            `INSERT INTO system_settings (settingKey, settingValue, updatedBy) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE settingValue = VALUES(settingValue), version = version + 1, updatedBy = VALUES(updatedBy)`,
            [KEY, JSON.stringify({ upvoteAlert: merged.upvoteAlert, downvoteHide: merged.downvoteHide }), accountId]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
    return { value: await getVoteSettings() };
}

module.exports = { KEY, LIMITS, defaults, validateVoteSettings, getVoteSettings, saveVoteSettings };
