// Scan quota (MySQL is authoritative: the counter must survive a restart).
// Split out of mysql.js; see mysql.js for the combined export list.

const settings = require('./settings');
const { resolveLimit } = require('./limits.js');
const { mysqlPool } = require('./pool-mysql');

// ---------------------------------------------------------------------------
// Scan quota (MySQL is authoritative: the counter must survive a restart)
// ---------------------------------------------------------------------------

/**
 * Start of the current fixed window, computed in JS so it cannot drift with the
 * pool timezone or a session-timezone change. windowStart is DATETIME, not
 * TIMESTAMP, for the same reason.
 */
function currentScanWindowStart(windowMs) {
    const size = windowMs || settings.ml.rateLimitWindowMs;
    return Math.floor(Date.now() / size) * size;
}

/** Whole seconds until the current window closes, at least 1. */
function scanWindowRetryAfterSeconds(windowMs) {
    const size = windowMs || settings.ml.rateLimitWindowMs;
    return Math.max(1, Math.ceil((size - (Date.now() % size)) / 1000));
}

/**
 * Charges one scan against the account's current window and returns the new
 * count. Charged on ATTEMPT, not on success, so a broken ML service cannot be
 * hammered; the caller's 502/504 paths still consume quota.
 *
 * FOR UPDATE serialises two simultaneous scans by the same account onto one
 * row. That is invisible at these limits and is not a reason to make the quota
 * approximate.
 */
async function consumeScanQuota(accountId, windowMs) {
    const windowStart = currentScanWindowStart(windowMs);
    // One value, one type, for all three statements. windowStart is DATETIME, so
    // a bare epoch number is compared as a numeric literal and silently never
    // matches the stored row: the SELECT would report "no row" every time and the
    // INSERT would then fail with a duplicate-key error that the route fails open
    // on. The quota would look enforced while charging nothing after the first
    // scan. windowStart = new Date(...) on its own is not a comparison a datetime
    // index can use either, hence both halves of this.
    const windowDate = new Date(windowStart);
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // Get roleId from account for per-role rate limit
        const [accountRows] = await conn.query('SELECT roleId FROM accounts WHERE accountId = ?', [accountId]);
        const roleId = accountRows[0]?.roleId;

        // Resolve rateLimitMax from role_limits -> system_settings -> settings.js
        let rateLimitMax;
        if (roleId) {
            const resolved = await resolveLimit(conn, 'rateLimitMax', roleId);
            rateLimitMax = typeof resolved === 'object' ? resolved.rateLimitMax : resolved;
        }
        if (!rateLimitMax) rateLimitMax = settings.ml.rateLimitMax;

        const [rows] = await conn.query(
            'SELECT scansUsed FROM ml_scan_usage WHERE accountId = ? AND windowStart = ? FOR UPDATE',
            [accountId, windowDate]
        );

        let used;
        if (rows.length === 0) {
            used = 1;
            await conn.query(
                'INSERT INTO ml_scan_usage (accountId, windowStart, scansUsed) VALUES (?, ?, 1)',
                [accountId, windowDate]
            );
        } else {
            used = rows[0].scansUsed + 1;
            await conn.query(
                'UPDATE ml_scan_usage SET scansUsed = ? WHERE accountId = ? AND windowStart = ?',
                [used, accountId, windowDate]
            );
        }

        await conn.commit();
        return { used, windowStart, windowEnd: windowStart + (windowMs || settings.ml.rateLimitWindowMs), limit: rateLimitMax };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = {
    currentScanWindowStart,
    scanWindowRetryAfterSeconds,
    consumeScanQuota
};
