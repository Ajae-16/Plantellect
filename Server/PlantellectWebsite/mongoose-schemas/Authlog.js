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
    'approval_mode_changed'
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
