const mongoose = require('mongoose');

/**
 * Auth AND administrative action log.
 *
 * `approval_mode_changed` is not an auth event, and it is here rather than in a
 * second collection because the question it answers is the same shape as the
 * others — "who did this, and when?" — and because "who turned auto approval on"
 * and "who clicked Approve" are two different facts about two different people
 * that must never be collapsed into one.
 *
 * An enum, so an unknown action is a validation failure rather than a silently
 * stored typo. logAuthEvent swallows that failure like every other one, which is
 * why the caller passes one of a closed set and the route validates first.
 */
const AUTHLOG_ACTIONS = [
    'login',
    'logout',
    'register',
    'failed_login',
    // An admin flipping an approval_auto_* switch. metadata carries the metaKey,
    // the requestType, and the before/after values.
    'approval_mode_changed',
    // Dataset page: an audit started, photos moved to / back from quarantine, a cluster reviewed or grouped,
    // a part row added, a species promoted or un-promoted. metadata.action says which.
    'dataset_changed',
    // Admin plant modal: a photo shown, hidden, made the primary photo, archived or unarchived.
    // metadata.action is 'hide' | 'show' | 'primary' | 'archive' | 'unarchive', with plantId and
    // imageId (and archiveReason for 'archive').
    'photo_visibility_changed',
    // Dashboard "Description feedback" card: an admin made a voted description the primary,
    // restored a hidden one, dismissed the alert, or took it out. metadata.action says which.
    'description_feedback_changed',
    // Users page: an admin created an account or edited one's email, username or name.
    // metadata carries targetAccountId (and the field names changed, never the values).
    'user_created',
    'user_updated',
    // Users page: an admin set another account's password (never stores the password itself).
    'user_password_reset',
    // Plants page: an admin archived or restored a whole plant. metadata.action says which.
    'plant_archive_changed',
    // Archive page and the plant edit dialog: a description archived or unarchived, anything put in the Deleted
    // status or taken back from it, or the retention days changed. metadata: { action: 'archive' | 'unarchive' |
    // 'delete' | 'undelete' | 'settings', kind: 'plant' | 'photo' | 'description', plantId, imageId?, descriptionId? }.
    // (A whole plant or a photo archived or restored keeps its own actions above.)
    'archive_changed',
    // Mobile profile API (routes/profile.js). Never stores the passwords themselves.
    // profile_updated metadata: { field: 'bio' | 'photo', ... }
    'password_changed',
    'password_change_failed',
    'profile_updated'
];

const authlogSchema = new mongoose.Schema(
    {
        // Account ids are prefixed strings ('acc_000001'), not integers.
        accountId: { type: String, required: true },
        action: { type: String, required: true, enum: AUTHLOG_ACTIONS },
        ip: { type: String, default: '' },
        userAgent: { type: String, default: '' },
        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { timestamps: true, collection: 'authlogs' }
);

const Authlog = mongoose.model('Authlog', authlogSchema);

async function logAuthEvent(data) {
    try {
        const log = new Authlog({
            accountId: data.accountId,
            action: data.action,
            ip: data.ip || '',
            userAgent: data.userAgent || '',
            metadata: data.metadata || {}
        });
        await log.save();
    } catch (err) {
        console.error('Failed to log auth event:', err.message);
    }
}

module.exports = { Authlog, logAuthEvent, AUTHLOG_ACTIONS };
