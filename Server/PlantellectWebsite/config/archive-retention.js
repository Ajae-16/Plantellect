// How many days a DELETED plant, photo or description is kept before the nightly job removes it for good.
// Admin-editable in Settings > Archive & Deletion; stored in system_settings under the key
// `archiveRetention` (JSON: { retentionDays }) like the other settings.
//
// Precedence: system_settings row -> settings.archive.retentionDays (env ARCHIVE_RETENTION_DAYS, default 30).
// A bad or missing stored value falls back to the default, and a failing read falls back too: an archive
// page must never fail because the settings table hiccuped. The floor is 1 day, so a typo of 0 can never
// remove something the moment it is deleted.
//
// Read on EVERY use, never cached: "I raised the retention and it still purged at 30" is how a cache bites.

const settings = require('./settings');

const KEY = 'archiveRetention';
const LIMITS = { retentionDays: { min: 1, max: settings.archive.retentionDaysMax } };

const defaultExecutor = () => require('./pool-mysql').mysqlPool;

function defaults() {
    return { retentionDays: settings.archive.retentionDays };
}

/** Validates what was SENT. Returns { value: { retentionDays } } or { error }. */
function validateRetention(input) {
    const body = input && typeof input === 'object' ? input : {};
    if (body.retentionDays === undefined) return { error: 'Nothing to save' };
    const raw = body.retentionDays;
    const text = String(raw).trim();
    const n = typeof raw === 'number' ? raw : Number(text);
    const { min, max } = LIMITS.retentionDays;
    if (text === '' || !Number.isInteger(n) || n < min || n > max) {
        return { error: `retentionDays must be a whole number from ${min} to ${max}` };
    }
    return { value: { retentionDays: n } };
}

function parseStored(raw) {
    if (raw == null) return {};
    if (typeof raw === 'string') {
        try { return JSON.parse(raw) || {}; } catch (err) { return {}; }
    }
    return typeof raw === 'object' ? raw : {};
}

/** The setting in force: { retentionDays, version, stored }. Never throws. */
async function getRetention(executor) {
    const out = { ...defaults(), version: 0, stored: false };
    try {
        const [rows] = await (executor || defaultExecutor()).query(
            'SELECT settingValue, version FROM system_settings WHERE settingKey = ?',
            [KEY]
        );
        if (!rows || rows.length === 0) return out;
        const saved = parseStored(rows[0].settingValue);
        const n = Number(saved.retentionDays);
        const { min, max } = LIMITS.retentionDays;
        if (Number.isInteger(n) && n >= min && n <= max) out.retentionDays = n;
        out.version = Number(rows[0].version) || 0;
        out.stored = true;
    } catch (err) {
        console.warn('archive-retention: using the default,', err.message);
    }
    return out;
}

/** Just the number of days. */
async function getRetentionDays(executor) {
    return (await getRetention(executor)).retentionDays;
}

/**
 * Saves the number. `version` (optional) is the version the editor loaded: when it no longer matches
 * nothing is written and the caller gets a 409, like the other settings.
 */
async function saveRetention(input, accountId, version, executor) {
    const checked = validateRetention(input);
    if (checked.error) return { error: checked.error, code: 400 };

    const db = executor || defaultExecutor();
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            'SELECT settingValue, version FROM system_settings WHERE settingKey = ? FOR UPDATE',
            [KEY]
        );
        const current = rows.length ? Number(rows[0].version) : 0;
        if (version !== undefined && version !== null && Number(version) !== current) {
            await conn.rollback();
            return { error: 'Someone else changed this setting. Reload and try again.', code: 409 };
        }
        await conn.query(
            `INSERT INTO system_settings (settingKey, settingValue, updatedBy) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE settingValue = VALUES(settingValue), version = version + 1, updatedBy = VALUES(updatedBy)`,
            [KEY, JSON.stringify({ retentionDays: checked.value.retentionDays }), accountId || null]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
    return { value: await getRetention(db) };
}

module.exports = { KEY, LIMITS, defaults, validateRetention, getRetention, getRetentionDays, saveRetention };
