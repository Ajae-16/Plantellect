// Nightly purge of DENIED change requests (Profile > Pending approval).
//
// A change request that was denied, by the contributor it was sent to or by an admin, stays on the
// requester's Pending approval list (and on the contributor's list) so they can read what happened.
// After settings.maintenance.deniedChangeRetentionDays days (default 30) this job deletes it.
//
// Only rows that are ALL of these are touched:
//   requestType = 'plant_change'   (photo / plant submissions have their own retention)
//   status      = 'denied'         (pending, approved and withdrawn requests are never deleted here)
//   decided longer ago than the cutoff (reviewedAt, or createdAt when no decision time was stored)
//
// Deleted in small batches so one night never holds a long lock.

const settings = require('./settings');

const DAY_MS = 24 * 60 * 60 * 1000;
const defaultExecutor = () => require('./pool-mysql').mysqlPool;

/**
 * Options (for tests): executor, now, days, batch.
 * Returns { purged, failed }. Never throws.
 */
async function purgeDeniedChangeRequests(options = {}) {
    const result = { purged: 0, failed: 0 };
    try {
        const db = options.executor || defaultExecutor();
        const now = options.now !== undefined ? new Date(options.now) : new Date();
        const days = Math.max(1, options.days !== undefined ? options.days : settings.maintenance.deniedChangeRetentionDays);
        const batch = Math.max(1, options.batch !== undefined ? options.batch : 200);
        const cutoff = new Date(now.getTime() - days * DAY_MS);

        for (;;) {
            const [res] = await db.query(
                `DELETE FROM approval_requests
                 WHERE requestType = 'plant_change' AND status = 'denied'
                   AND COALESCE(reviewedAt, createdAt) < ?
                 LIMIT ${Number(batch)}`,
                [cutoff]
            );
            const removed = Number(res && res.affectedRows) || 0;
            result.purged += removed;
            if (removed < batch) break;
        }
    } catch (err) {
        result.failed++;
        console.error('Denied change request purge failed:', err.message);
    }
    return result;
}

/** One log line, or '' when nothing happened. */
function describe(result) {
    if (!result || (!result.purged && !result.failed)) return '';
    return `Denied change requests: ${result.purged} deleted` + (result.failed ? `, ${result.failed} failed` : '');
}

module.exports = { purgeDeniedChangeRequests, describe };
