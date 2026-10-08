require('dotenv').config(); // Load the root .env file once
const path = require('path');

// configurable settings
// sessionTimeout = MongoDB TTL duration (session cleanup after inactivity)
const sessionTimeout = 24 // hours
// rememberTimeout = persistent cookie duration when "remember me" is checked
const rememberTimeout = 720 // hours

const tzOffset = process.env.TZ_OFFSET || '+08:00';      //timezone of Asia/Manila Philippines
const tzName = process.env.TZ || 'Asia/Manila'; 
// File directory for storing botanist certificates.
const certificateDir = path.join(__dirname, '..', 'administration', 'botanist', 'certificates'); 
// File size to accept for thr certificares.
const maxCertificatesSize = 20 // start with MB
// File directory for community-uploaded plant photos. These are NOT served
// statically; routes/plants.js streams approved ones on request.
const plantImageDir = path.join(__dirname, '..', 'administration', 'botanist', 'plant-images');
const maxPlantImageSize = 10 // MB

/**
 * Reads an integer environment variable.
 *
 * Deliberately NOT `parseInt(raw) || fallback`. That idiom treats 0 as missing,
 * so a setting can never legitimately be zero — which makes the discovery
 * cooldown untestable and silently rewrites a deliberate "off" into a default.
 * Here only a missing, empty or non-numeric value falls back, and a negative one
 * is clamped to zero because every limit below is an "at most" count and a
 * negative cap has no meaning.
 */
function numberSetting(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, parsed);
}

module.exports = {
    server: {
        port: parseInt(process.env.PORT, 10) || 3000,
        env: process.env.NODE_ENV || 'development'
    },
    database: {
        mongoUri: process.env.MONGO_URI,
        mysqlHost: process.env.DB_HOST
    },
    session: {
        secret: process.env.SESSION_SECRET,
        cookieTimeout: sessionTimeout * 60 * 60 * 1000, // session timeout in milliseconds (used for MongoDB TTL)
        rememberMeTimeout: rememberTimeout * 60 * 60 * 1000, // remember me persistent cookie duration in milliseconds
        cookieSecure: process.env.SESSION_COOKIE_SECURE === 'true'
    },
    system: {
        // Exposing this in config lets you easily check the active timezone across entire project
        timezone: tzOffset,          
        timezoneName: tzName
    },
    certificates: {
        storageDir: certificateDir,
        maxSizeBytes: maxCertificatesSize * 1024 * 1024, // KB, B
        allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
        allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
        maxFilenameLength: 255,
        filenameStrategy: 'uuid'
    },
    plantImages: {
        storageDir: plantImageDir,
        // Subfolder under storageDir for discovery-report photos, keyed by
        // <requestId> inside it. Under the EXISTING storageDir on purpose: no new
        // directory is statically served, and the shared fileFilter and
        // maxSizeBytes apply unchanged — a report cannot become a way to upload
        // something the library would reject.
        discoverySubdir: 'discoveries',
        maxSizeBytes: maxPlantImageSize * 1024 * 1024, // per file
        maxFilesPerRequest: 20,
        // A report is evidence, not a photo album: three is enough to identify a
        // plant and few enough that the per-account open-report cap bounds disk.
        maxDiscoveryFiles: 3,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp'],
        filenameStrategy: 'uuid'
    },
    pagination: {
        // Every list route clamps to these instead of hardcoding a page size.
        defaultPageSize: 10,
        maxPageSize: 50,
        allowClientOverride: true
    },
    terms: {
        // Bump when the terms text in auth.html changes so stored consents
        // become visibly stale and can be re-collected.
        version: '1.0'
    },
    discoveries: {
        // Both caps count LIVE state, never lifetime history: a claim while its
        // report is unresolved, a report while it is pending. So neither
        // permanently exhausts an account, and both are enforced server-side in
        // the same transaction as the write they guard — a bare count-then-insert
        // lets two rapid requests both read 9 and both succeed at 10.
        //
        // Twenty claims is deliberately generous: it still stops one botanist
        // draining a large queue and leaving nothing for anyone else, while never
        // being the reason a capable one cannot work in parallel with others.
        maxClaimsPerBotanist: numberSetting('DISCOVERIES_MAX_CLAIMS', 20),
        maxOpenReportsPerAccount: numberSetting('DISCOVERIES_MAX_OPEN_REPORTS', 10),
        // Cancel is bounded by a grace window and filing by a cooldown, on two
        // different paths: together they let a legitimate user fix a mistake
        // immediately while capping churn at one report per cooldown per account.
        cancelGraceHours: numberSetting('DISCOVERIES_CANCEL_GRACE_HOURS', 24),
        reportCooldownMinutes: numberSetting('DISCOVERIES_REPORT_COOLDOWN_MIN', 10),
        // Also the voting-eligibility window  Ninety days is chosen so
        // expiry cannot cost legitimate work: nothing reasonable takes three
        // months on one record.
        claimStaleDays: numberSetting('DISCOVERIES_CLAIM_STALE_DAYS', 90),
        // A CEILING, not the quorum itself: the effective threshold is
        // max(2, min(this, ceil(activeBotanists / 2))). Five with five
        // botanists is unanimity, and unanimity means one holdout can never save
        // one. The floor of 2 is what stops a single botanist closing a report
        // alone. Zero disables the quorum entirely — the
        // effectiveNotAPlantThreshold floor of 2 still applies, so it cannot
        // become a single-person decision.
        notAPlantVotes: numberSetting('DISCOVERIES_NOT_A_PLANT_VOTES', 5),
        // Photos are purged for every CLOSED report — cancelled, denied, rejected
        // — while the report row and its discovery_votes are kept indefinitely.
        // The image is the most intrusive artefact; the row plus the ballot is the
        // audit. Cancel differs only in timing: it deletes at once.
        discoveryClosedPhotoDays: parseInt(process.env.DISCOVERY_CLOSED_PHOTO_DAYS, 10) || 90
    },
    ml: {
        serviceUrl: process.env.ML_SERVICE_URL || 'http://localhost:8001',
        timeoutMs: parseInt(process.env.ML_TIMEOUT_MS, 10) || 30000,
        defaultModel: process.env.ML_DEFAULT_MODEL || 'efficientnetv2b1',
        // Route code must never hardcode any of these, same rule as
        // settings.plantImages / settings.certificates.
        // The uploader had no limits at all and buffered the whole multipart
        // body in RAM, so any signed-in account could OOM the process.
        maxUploadBytes: (parseInt(process.env.ML_MAX_UPLOAD_MB, 10) || 10) * 1024 * 1024,
        maxTopK: parseInt(process.env.ML_MAX_TOP_K, 10) || 10,
        // Fixed-window quota, charged on attempt. Not a sliding window: that
        // cannot be stored in two columns and is not worth it at this scale, so
        // an account can spend up to 2x rateLimitMax across a boundary.
        rateLimitMax: parseInt(process.env.ML_RATE_LIMIT_MAX, 10) || 30,
        rateLimitWindowMs: (parseInt(process.env.ML_RATE_LIMIT_WINDOW_MIN, 10) || 10) * 60 * 1000,
        // Both windows default to a year so every month of a calendar year stays
        // queryable in the leaderboard and the review audit. Raise
        // ML_RETENTION_DAYS during a write-up period rather than exporting.
        retentionDays: parseInt(process.env.ML_RETENTION_DAYS, 10) || 365,
        rejectedImageRetentionDays: parseInt(process.env.ML_REJECTED_RETENTION_DAYS, 10) || 365
    }
};
