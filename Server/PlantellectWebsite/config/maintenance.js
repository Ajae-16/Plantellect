// Nightly housekeeping for the photo store (dataset handler).
//
//   startup  reconcile the public copies (config/reconcile.js)
//   nightly  reconcile the public copies, then purge old denied photos (config/retention.js), then remove the
//            archived plants / photos / descriptions that have been in the Deleted status for longer than the
//            archive retention days (config/archive-delete-mysql.js)
//
// "Nightly" is settings.maintenance.nightlyHour (default 03:00) in the server's local time.
// The timer is unref()'d so it never keeps the process alive, a run that is still going
// when the next one is due is skipped, and a job that throws is logged and the schedule
// carries on.

const settings = require('./settings');
const reconcile = require('./reconcile');
const retention = require('./retention');
const archiveDelete = require('./archive-delete-mysql');

/** Milliseconds from `now` until the next `hour`:00 local time (always more than 0). */
function msUntilNext(now, hour) {
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
}

/** The reconcile pass, logged. Used at startup and as the first half of the nightly run. */
async function runReconcile(deps = {}) {
    const run = deps.reconcile || reconcile.reconcilePublicCopies;
    const log = deps.log || console.log;
    const summary = await run();
    const line = reconcile.describe(summary);
    if (line) log(line);
    return summary;
}

/** One nightly run: reconcile, then retention. Each job is isolated from the other's failure. */
async function runNightly(deps = {}) {
    const log = deps.log || console.log;
    const out = {};
    try {
        out.reconcile = await runReconcile(deps);
    } catch (err) {
        console.error('Nightly reconcile failed:', err.message);
    }
    try {
        out.retention = await (deps.retention || retention.purgeDeniedPhotos)();
        const line = retention.describe(out.retention);
        if (line) log(line);
    } catch (err) {
        console.error('Nightly retention failed:', err.message);
    }
    try {
        out.archivePurge = await (deps.archivePurge || archiveDelete.purgeExpired)();
        const line = archiveDelete.describe(out.archivePurge);
        if (line) log(line);
    } catch (err) {
        console.error('Nightly archive purge failed:', err.message);
    }
    return out;
}

let timer = null;

/** Schedules the nightly run and keeps rescheduling it. Returns a function that stops it. */
function scheduleNightly(deps = {}) {
    const hour = deps.hour !== undefined ? deps.hour : settings.maintenance.nightlyHour;
    const clock = deps.now || (() => new Date());
    const setTimer = deps.setTimeout || setTimeout;
    const clearTimer = deps.clearTimeout || clearTimeout;
    let active = true;
    let busy = false;

    const arm = () => {
        if (!active) return;
        timer = setTimer(async () => {
            if (!busy) {
                busy = true;
                try { await runNightly(deps); } finally { busy = false; }
            }
            arm();
        }, msUntilNext(clock(), hour));
        if (timer && typeof timer.unref === 'function') timer.unref();
    };
    arm();

    return function stop() {
        active = false;
        if (timer) clearTimer(timer);
        timer = null;
    };
}

module.exports = { msUntilNext, runReconcile, runNightly, scheduleNightly };
