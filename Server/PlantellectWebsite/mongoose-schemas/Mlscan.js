/**
 * Per-prediction ML usage feed.
 *
 * MySQL is the authoritative store for the quota; this is the append-only
 * analytics stream, one document per /api/ml/predict request. It follows
 * logAuthEvent's contract exactly: a prediction is never failed by logging.
 *
 * The scanned image is NOT stored here. It only ever exists in multer's
 * memoryStorage, so this collection must not imply there is a copy anywhere.
 */
const mongoose = require('mongoose');

const settings = require('../config/settings');

const mlScanSchema = new mongoose.Schema(
    {
        // Account ids are prefixed strings ('acc_000001'), not integers.
        accountId: { type: String, required: true },
        action: { type: String, required: true, enum: ['ml_predict'], default: 'ml_predict' },
        // Failures are logged too, so the feed can show failure rates.
        status: { type: String, required: true, enum: ['ok', 'error'] },
        topK: { type: Number, default: null },
        modelVersion: { type: String, default: '' },
        inferenceMs: { type: Number, default: null },
        predictions: {
            type: [{
                scientificName: { type: String, default: '' },
                commonName: { type: String, default: '' },
                confidence: { type: Number, default: 0 },
                // Null means "the library has no such species". Unreliable when
                // linksResolved is false — see below.
                plantId: { type: String, default: null },
                rank: { type: Number, default: null }
            }],
            default: []
        },
        /**
         * False when the plants lookup failed, which leaves every prediction in
         * this event with no plantId. Those events must be excluded from the
         * species-gap feed, or a database blip reads as "the library is missing
         * every species anyone scanned".
         */
        linksResolved: { type: Boolean, default: false },
        /**
         * True once a discovery report was filed from this scan.
         *
         * The only overlap counter between the two features, and it answers one
         * question: is this species-gap signal action, or has somebody already
         * raised it? Without it the admin coverage page counts a gap that is
         * already being worked on — which is exactly the way a signal gets
         * ignored.
         *
         * Set out of band by config/mysql.js's markRecentScansReported, not at
         * write time: the report is filed after the prediction, minutes later,
         * from a different request and possibly a different page. Defaults to
         * false so every existing document reads as unreported.
         */
        reported: { type: Boolean, default: false },
        ip: { type: String, default: '' },
        userAgent: { type: String, default: '' },
        // Mongo's TTL index (expireAfterSeconds: 0) collects the document once
        // this passes. A document can outlive it briefly: the monitor is
        // backgrounded.
        expiresAt: { type: Date, required: true }
    },
    { timestamps: true, collection: 'mlscans' }
);

mlScanSchema.index({ createdAt: -1 });
mlScanSchema.index({ accountId: 1, createdAt: -1 });
// The coverage query reads reported as well as createdAt, so the flag is indexed
// rather than filtered in JavaScript.
mlScanSchema.index({ reported: 1, createdAt: -1 });
mlScanSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Mlscan = mongoose.model('Mlscan', mlScanSchema);

async function logMlScan(data) {
    try {
        const log = new Mlscan({
            accountId: data.accountId,
            status: data.status === 'ok' ? 'ok' : 'error',
            topK: data.topK ?? null,
            modelVersion: data.modelVersion || '',
            inferenceMs: data.inferenceMs ?? null,
            predictions: Array.isArray(data.predictions) ? data.predictions : [],
            linksResolved: Boolean(data.linksResolved),
            ip: data.ip || '',
            userAgent: data.userAgent || '',
            expiresAt: new Date(Date.now() + settings.ml.retentionDays * 24 * 60 * 60 * 1000)
        });
        await log.save();
    } catch (err) {
        // Swallowed on purpose: analytics must never take a prediction down.
        console.error('Failed to log ML scan:', err.message);
    }
}

module.exports = { Mlscan, mlScanSchema, logMlScan };