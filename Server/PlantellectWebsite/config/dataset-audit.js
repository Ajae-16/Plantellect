// config/dataset-audit.js
//
// When is "Run audit now" worth a second thought? An audit re-reads every photo of the dataset folder, so with several
// admins on the Dataset page two of them can easily start one right after the other for no gain. This decides whether the
// last audit is recent enough to ask first. It is checked on the SERVER from the ML service's own record of the last
// run, not from what a page happened to show, so an admin whose page is minutes old is protected as well.
//
// Only a run that finished normally counts. A failed or interrupted audit can be retried at once, and a running one is
// refused by the ML service itself.

const settings = require('./settings');

// The audit command exits 0 when the dataset is clean and 2 when it found something to review. Both are a finished run.
const FINISHED_OK = [0, 2];

/**
 * The last run, when it ended less than `minutes` ago and ended normally. Otherwise null.
 * status is the ML service's /dataset/status: { running, startedAt, startedBy, finishedAt, exitCode }.
 * Returns { at (ISO), minutesAgo, by } for the caller to show.
 */
function recentAudit(status, { now = Date.now(), minutes = settings.dataset.auditRecentMinutes } = {}) {
    if (!status || status.running) return null;
    if (!FINISHED_OK.includes(status.exitCode)) return null;
    const ended = Date.parse(status.finishedAt || status.startedAt || '');
    if (!Number.isFinite(ended)) return null;
    // Two containers' clocks are never exactly equal: a run that "ended" a few seconds in the future just ended.
    const ageMs = Math.max(0, now - ended);
    if (ageMs >= minutes * 60 * 1000) return null;
    return { at: new Date(ended).toISOString(), minutesAgo: Math.floor(ageMs / 60000), by: String(status.startedBy || '') };
}

/** The question the page asks before it runs another audit. */
function recentMessage(recent) {
    const who = recent.by || 'An admin';
    const ago = recent.minutesAgo < 1 ? 'less than a minute' : `${recent.minutesAgo} minute${recent.minutesAgo === 1 ? '' : 's'}`;
    return `${who} ran an audit ${ago} ago. Running another one now repeats the same work. Run it anyway?`;
}

module.exports = { recentAudit, recentMessage, FINISHED_OK };
