const mongoose = require('mongoose');

const authlogSchema = new mongoose.Schema(
    {
        accountId: { type: Number, required: true },
        action: { type: String, required: true, enum: ['login', 'logout', 'register', 'failed_login'] },
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

module.exports = { Authlog, logAuthEvent };
