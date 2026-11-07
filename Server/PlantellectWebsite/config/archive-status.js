// Archive and Deleted status of a plant, a photo or a description. Pure: no database, no clock of its own.
//
//   active    archivedAt and deletedAt are both NULL
//   archived  archivedAt is set: out of the public pages, the app and the training set, nothing removed
//   deleted   deletedAt is set (archivedAt stays set, so it stays hidden). Nothing is removed yet:
//             the nightly job removes it once deletedAt is older than the archive retention days
//             (Settings > Archive & Deletion). Until then an admin can undo the deletion.
//
// A photo or a description also follows its plant: when the plant is archived or deleted, the pieces
// inside show that status too (effectiveState) even if the piece itself was never touched.

const DAY_MS = 24 * 60 * 60 * 1000;

const STATES = ['active', 'archived', 'deleted'];

const asDate = (value) => {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
};

/** 'deleted' | 'archived' | 'active' from the two timestamps of ONE row. */
function stateOf(row) {
    if (!row) return 'active';
    if (row.deletedAt) return 'deleted';
    if (row.archivedAt) return 'archived';
    return 'active';
}

/** When a row deleted at `deletedAt` is removed for good, or null when it was not deleted. */
function purgeAtOf(deletedAt, retentionDays) {
    const when = asDate(deletedAt);
    if (!when) return null;
    return new Date(when.getTime() + Math.max(1, Number(retentionDays) || 1) * DAY_MS);
}

/** Whole days left before the purge (rounded UP, never below 0), or null when not deleted. */
function daysLeftOf(purgeAt, now = new Date()) {
    const when = asDate(purgeAt);
    if (!when) return null;
    return Math.max(0, Math.ceil((when.getTime() - asDate(now).getTime()) / DAY_MS));
}

/**
 * The status of one row as the APIs send it.
 *   { state, archivedAt, deletedAt, purgeAt, daysLeft }
 * `retentionDays` is the live setting. The reason an admin typed is NOT part of this: it is an internal
 * note, so the user-facing API never gets it (the admin pages read archiveReason themselves).
 */
function describeStatus(row, retentionDays, now = new Date()) {
    const state = stateOf(row);
    const purgeAt = state === 'deleted' ? purgeAtOf(row.deletedAt, retentionDays) : null;
    return {
        state,
        archivedAt: asDate(row && row.archivedAt),
        deletedAt: asDate(row && row.deletedAt),
        purgeAt,
        daysLeft: purgeAt ? daysLeftOf(purgeAt, now) : null
    };
}

/**
 * The status a PIECE (photo / description) really has, taking its plant into account: the plant being
 * deleted makes every piece deleted (removed together with the plant, at the plant's purge time unless the
 * piece's own is earlier); the plant being archived makes an active piece archived.
 * Returns the describeStatus shape plus `via`: 'self' or 'plant' (what put it in that state).
 */
function effectiveStatus(piece, plant, retentionDays, now = new Date()) {
    const own = describeStatus(piece, retentionDays, now);
    const parent = describeStatus(plant, retentionDays, now);
    if (own.state === 'deleted' && parent.state === 'deleted') {
        return (own.purgeAt <= parent.purgeAt ? { ...own, via: 'self' } : { ...parent, via: 'plant' });
    }
    if (own.state === 'deleted') return { ...own, via: 'self' };
    if (parent.state === 'deleted') return { ...parent, via: 'plant' };
    if (own.state === 'archived') return { ...own, via: 'self' };
    if (parent.state === 'archived') return { ...parent, via: 'plant' };
    return { ...own, via: 'self' };
}

module.exports = { DAY_MS, STATES, stateOf, purgeAtOf, daysLeftOf, describeStatus, effectiveStatus };
