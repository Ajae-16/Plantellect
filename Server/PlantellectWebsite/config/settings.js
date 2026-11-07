require('dotenv').config(); // Load the root .env file once
const path = require('path');

// configurable settings
// sessionTimeout = MongoDB TTL duration (session cleanup after inactivity)
const sessionTimeout = 24 // hours
// rememberTimeout = persistent cookie duration when "remember me" is checked
const rememberTimeout = 720 // hours

const tzOffset = process.env.TZ_OFFSET || '+08:00';      //timezone of Asia/Manila Philippines
const tzName = process.env.TZ || 'Asia/Manila'; 
// File directory for community-uploaded plant photos (the plant inventory). These are NOT served
// statically; routes/plants.js streams approved ones on request.
const plantImageDir = path.join(__dirname, '..', 'administration', 'inventory', 'plant-images');
const maxPlantImageSize = 10 // MB
// Profile photos of the users themselves (mobile app). Same private-storage idea as the plant
// photos: NOT served statically; routes/profile.js streams them on request.
const userImageDir = path.join(__dirname, '..', 'administration', 'inventory', 'user-images');
const maxUserImageSize = 10 // MB

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
    plantImages: {
        storageDir: plantImageDir,
        // Subfolder under storageDir for discovery-report photos, keyed by
        // <requestId> inside it. Under the EXISTING storageDir on purpose: no new
        // directory is statically served, and the shared fileFilter and
        // maxSizeBytes apply unchanged — a report cannot become a way to upload
        // something the library would reject.
        discoverySubdir: 'discoveries',
        // Subfolder under storageDir for plant photos. Both subdirs split into one
        // folder per review state (statusFolders below), so the tree is
        //   plant-images/plants/{pending,approved,denied}/<key>/<file>
        //   plant-images/discoveries/{pending,approved,denied}/<requestId>/<file>
        plantSubdir: 'plants',
        // Review state -> folder. plant_images.status 'rejected' and a discovery
        // report that is 'denied' or 'rejected' all land in 'denied'.
        statusFolders: { pending: 'pending', approved: 'approved', denied: 'denied' },
        // A file is COPIED to its new folder and the copy is verified (same bytes,
        // readable image). Only then is the source deleted. A failed copy is
        // retried up to this many times before the admin is told on the plants page.
        copyMaxAttempts: Math.max(1, numberSetting('IMAGE_COPY_MAX_ATTEMPTS', 5)),
        copyRetryDelayMs: numberSetting('IMAGE_COPY_RETRY_DELAY_MS', 200),
        // A photo that has been denied for longer than this many days has its master
        // deleted by the nightly retention job (a tombstone of hash and reason is kept).
        // Only denied photos are deleted automatically; pending ones stay. At least 1,
        // so a typo of 0 cannot delete a photo the moment it is denied.
        deniedRetentionDays: Math.max(1, numberSetting('DENIED_RETENTION_DAYS', 30)),
        // Cache lifetime, in seconds, of the static public copies in
        // public/resource/plant-images. Read once at startup: a change needs a restart.
        // 0 turns the cache off.
        publicCacheSeconds: numberSetting('PUBLIC_IMAGE_CACHE_SECONDS', 300),
        // Reconcile job (config/reconcile.js). A file in the public folder with no visible
        // record is deleted only when it is older than this many seconds, so a copy that is
        // being written (a restore builds the files BEFORE it sets the flag) is never
        // mistaken for an orphan. At least 10.
        orphanGraceSeconds: Math.max(10, numberSetting('PUBLIC_ORPHAN_GRACE_SECONDS', 120)),
        // Most denied photos the retention job purges in one run; the rest wait for the next night.
        retentionBatchSize: Math.max(1, numberSetting('RETENTION_BATCH_SIZE', 500)),
        // Static public copies . Written ONLY by the server, from a master, and
        // served by their own handler in index.js (WebP only, nosniff, no listing).
        // Under public/ so the URL is /resource/plant-images/<size>/<plantId>/<imageId>.webp.
        publicDir: path.join(__dirname, '..', 'public', 'resource', 'plant-images'),
        publicUrlBase: '/resource/plant-images',
        // Longest side in pixels. A copy is never enlarged.
        thumbnailLongEdge: Math.max(64, numberSetting('PUBLIC_THUMBNAIL_LONG_EDGE', 480)),
        displayLongEdge: Math.max(256, numberSetting('PUBLIC_DISPLAY_LONG_EDGE', 1280)),
        publicCopyQuality: Math.min(100, Math.max(40, numberSetting('PUBLIC_COPY_QUALITY', 82))),
        maxSizeBytes: maxPlantImageSize * 1024 * 1024, // per file
        // Per-submission photo cap. This is the FALLBACK: the live value is the
        // admin-editable system_settings key 'plantImages' (see
        // getPlantImageLimits in setting-mysql.js). MAX_PLANT_IMAGES_PER_REQUEST
        // seeds the default for a fresh install; hardMaxFilesPerRequest is the
        // ceiling the admin form will accept, so a typo cannot lift the cap off.
        maxFilesPerRequest: Math.max(1, numberSetting('MAX_PLANT_IMAGES_PER_REQUEST', 20)),
        hardMaxFilesPerRequest: 100,
        // The admin plant editor loads its photo panel one page at a time. This is the FALLBACK page
        // size; the live value is plantImages.adminPhotosPerPage in system_settings (Settings > Plant
        // Photo Limit), clamped to 1..adminPhotosPerPageMax so a typo cannot ask for every photo at once.
        adminPhotosPerPage: 12,
        adminPhotosPerPageMax: 50,
        // A report is evidence, not a photo album: three is enough to identify a
        // plant and few enough that the per-account open-report cap bounds disk.
        maxDiscoveryFiles: 3,
        // HEIC/HEIF (iPhone) is accepted and CONVERTED, never stored as is: see
        // config/image-ingest.js. The real type is decided from the bytes there.
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
        allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'],
        // Windows browsers often send no type, or application/octet-stream, for a
        // .heic file. For these extensions only, that generic type is let through
        // the first gate; the bytes are still checked afterwards.
        genericMimeExtensions: ['.heic', '.heif'],
        // Folder, inside each image root, that holds the masters. A master is the
        // re-encoded, metadata-free WebP. It is written once and never moves, whatever
        // the review status. Under the plant root: plants/masters/<plantId or requestId>/.
        // Under the discovery root: masters/<requestId>/.
        masterSubdir: 'masters',
        filenameStrategy: 'uuid'
    },
    // A user's own profile photo. One photo per account, stored as
    //   user-images/<accountId>.webp      (e.g. acc_000007.webp: found from the user id alone)
    // and recorded in profiles.imagePath (the file name). The upload goes through the same
    // ingest pipeline as plant photos (real type check, HEIC conversion, re-encode to a metadata-free WebP),
    // so what is stored is always a clean master, never the raw upload.
    userImages: {
        storageDir: userImageDir,
        // Temporary landing zone for the raw upload; emptied as soon as the request ends.
        incomingSubdir: '_incoming',
        maxSizeBytes: maxUserImageSize * 1024 * 1024, // per file: 10 MB
        maxFilesPerRequest: 1,
        // Multipart field name the mobile app sends the photo under.
        fieldName: 'image',
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
        allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'],
        genericMimeExtensions: ['.heic', '.heif'],
        // A profile photo is shown small; the master of a plant photo (2048) is more than it needs.
        masterLongEdge: Math.max(256, numberSetting('USER_IMAGE_LONG_EDGE', 1024)),
        bioMaxLength: 500
    },
    // The upload pipeline (config/image-ingest.js): type check, HEIC conversion,
    // re-encode to the master WebP, hashing.
    ingest: {
        // Longest side of a master, in pixels. Smaller photos are never enlarged.
        masterLongEdge: Math.max(256, numberSetting('INGEST_MASTER_LONG_EDGE', 2048)),
        masterQuality: Math.min(100, Math.max(40, numberSetting('INGEST_MASTER_QUALITY', 90))),
        // Decompression-bomb guard: a photo with more pixels than this is refused
        // before it is decoded. 80 million covers every phone camera.
        maxInputPixels: Math.max(1000000, numberSetting('INGEST_MAX_PIXELS', 80000000)),
        // How long the website waits for the ML service to convert one HEIC photo.
        heicTimeoutMs: Math.max(1000, numberSetting('INGEST_HEIC_TIMEOUT_MS', 20000))
    },
    // "Looks like photo X" hints shown to the reviewer at approval (config/lookalike.js).
    // A hint never blocks an approval. The two thresholds are STARTING values from the
    //  must be calibrated on real photos before anyone relies on
    // them; the hash distance  note that a resized copy differed by
    // 6 to 9 of 64 bits.
    lookalike: {
        // Largest Hamming distance (of 64 bits) between two dHashes that is still called a near copy.
        hashMaxDistance: Math.max(0, Math.min(32, numberSetting('LOOKALIKE_HASH_MAX_DISTANCE', 8))),
        // Embedding cosine similarity from which two photos are "the same shot" and "similar".
        sameShotSimilarity: numberSetting('LOOKALIKE_SAME_SHOT', 0.97),
        similarSimilarity: numberSetting('LOOKALIKE_SIMILAR', 0.93),
        // How many of the plant's approved photos a pending photo is compared against
        // (newest first), and how many hints one photo shows.
        embeddingReferenceCap: Math.max(0, numberSetting('LOOKALIKE_REFERENCE_CAP', 30)),
        maxHintsPerPhoto: Math.max(1, numberSetting('LOOKALIKE_MAX_HINTS', 3)),
        // Most approved hashes read for the cross-species check.
        hashPoolCap: Math.max(100, numberSetting('LOOKALIKE_HASH_POOL', 20000)),
        // Photos are shrunk to this long edge before they go to the ML service.
        sendLongEdge: Math.max(128, numberSetting('LOOKALIKE_SEND_LONG_EDGE', 256)),
        timeoutMs: Math.max(1000, numberSetting('LOOKALIKE_TIMEOUT_MS', 20000))
    },
    // Dataset handler, database-linked half: which photos feed a training set, and where the
    // database snapshots are written for the ML service to read.
    dataset: {
        // The host folder the ML container mounts as /data/datasets (docker-compose.yml: ./datasets).
        dir: process.env.DATASET_DIR ? path.resolve(process.env.DATASET_DIR) : path.join(__dirname, '..', 'datasets'),
        // Database snapshots live here, one numbered folder each, NEXT TO (not inside) the hand-made
        // training folder, so the admin page's audit of that folder never picks them up.
        snapshotSubdir: 'db-snapshots',
        // The part names a photo may carry. Organisation and reporting only, never a label. Keep it in step
        // with "parts" in datasets/index/config.json (the ML side warns about a part it does not know).
        parts: (process.env.DATASET_PARTS || 'Leaves,Leaves with stem,Whole plant')
            .split(',').map((p) => p.trim()).filter(Boolean),
        // Most photos one training-status change may touch at once.
        maxBulk: Math.max(1, numberSetting('DATASET_MAX_BULK', 200)),
        // Most Other plant photos ONE bulk move may assign to a plant (Dataset page > Other plant inbox). Bigger than
        // maxBulk on purpose: moving 300 photos of one species is one decision, not 300.
        maxBulkMove: Math.max(1, numberSetting('DATASET_MAX_BULK_MOVE', 500)),
        // "Run audit now" asks first when the last audit ended less than this many minutes ago (config/dataset-audit.js).
        auditRecentMinutes: Math.max(1, numberSetting('DATASET_AUDIT_RECENT_MINUTES', 10)),
        groupKeyMaxLength: 100,
        reasonMaxLength: 255,
        // Most Other plant photos ONE species adds to a snapshot ("capped per species"), so a few
        // species with hundreds of photos cannot make up most of the one Other plant class. 0 means no cap.
        otherPlantCap: Math.max(0, numberSetting('DATASET_OTHER_PLANT_CAP', 100)),
        // Keeping several admins' views of the dataset in step (config/dataset-sync.js, routes/admin-dataset.js).
        sync: {
            // How often an open Dataset page asks "did anything change?". The server hands this number to the page, so
            // going from "slow" to "nearly live" is ONE setting, no page change: 10-15 now, 2-3 later
            // (DATASET_SYNC_POLL_SECONDS=3). An unchanged answer is a bodyless 304, so a short interval is cheap.
            pollSeconds: Math.min(60, Math.max(2, numberSetting('DATASET_SYNC_POLL_SECONDS', 12))),
            // How many of the newest change-log rows an answer carries (a page that was away longer is told to refresh).
            tail: 40,
            // Change-log rows older than this many days are deleted by the housekeeping job.
            retentionDays: Math.max(1, numberSetting('DATASET_SYNC_RETENTION_DAYS', 30)),
            // How long a lock survives without being renewed. An operation lock only lives for one request, so its lease is
            // just a safety net for a crash; a claim ("Ben is working on this") is renewed by the open page every third of it.
            opLockSeconds: 60,
            claimLockSeconds: 90,
            snapshotLockSeconds: 900,
            // A SPECIES LOCK is an admin's explicit "this species is mine for now": nobody else may move, remove or group
            // its photos (in train, val and test alike) or move photos into it. The open page renews it every third of the
            // lease, so a closed tab or a crashed browser frees it within speciesLockSeconds. A page that has seen no mouse
            // or keyboard for speciesIdleMinutes stops renewing, so a tab left open overnight cannot hold a species forever.
            // speciesLockMax keeps one admin from locking the whole dataset.
            speciesLockSeconds: Math.max(60, numberSetting('DATASET_SPECIES_LOCK_SECONDS', 300)),
            speciesIdleMinutes: Math.max(1, numberSetting('DATASET_SPECIES_IDLE_MINUTES', 20)),
            speciesLockMax: Math.max(1, numberSetting('DATASET_SPECIES_LOCK_MAX', 5)),
            // Most photos one claim may mark. A claim is a courtesy marker, so it is capped lower than a bulk move.
            claimMaxKeys: 200,
            // Expired locks are swept (and the lock counter bumped, so a stale "Ben is working" marker goes away) this often.
            sweepSeconds: 20
        }
    },
    // Species promotion (config/species-promotion.js): moving a species from Other plant to a
    // supported species. The minimum is the plan's proposed starting value.
    // classesPath is an OPTIONAL override (SPECIES_CLASSES_PATH). Left empty, the class list is the active model's
    // ml/model/<model>/classes.json, the same file the admin coverage route and the database snapshot read
    // (config/active-classes.js). Either way it is re-read whenever the file changes.
    speciesPromotion: {
        minUniquePhotos: Math.max(1, numberSetting('SPECIES_PROMOTE_MIN_PHOTOS', 50)),
        classesPath: process.env.SPECIES_CLASSES_PATH || ''
    },
    // Other plant inbox (config/other-plant.js): suggesting which existing plant an unassigned scan contribution looks like,
    // using the embedder chosen on the dataset page (a saved model, or MobileNet) in the ML service.
    otherPlant: {
        // How many photos of each existing plant a photo is compared with (the plant's primary first, then by id).
        refsPerPlant: Math.max(1, Math.min(30, numberSetting('OTHER_PLANT_REFS_PER_PLANT', 6))),
        // Most photos sent to the ML service to be embedded in ONE request of the page. What is left is reported
        // ("still learning") and the admin presses the button again; the vectors are kept, so nothing is sent twice.
        embedBudget: Math.max(1, numberSetting('OTHER_PLANT_EMBED_BUDGET', 80)),
        uploadBatch: Math.max(1, Math.min(40, numberSetting('OTHER_PLANT_UPLOAD_BATCH', 16))),
        // Photos are shrunk to this long edge before they go to the ML service (the model resizes to its own input).
        sendLongEdge: Math.max(128, numberSetting('OTHER_PLANT_SEND_LONG_EDGE', 320)),
        // Embedding a batch on a CPU container can take a while; this is longer than settings.ml.timeoutMs on purpose.
        timeoutMs: Math.max(5000, numberSetting('OTHER_PLANT_TIMEOUT_MS', 120000)),
        // Most photos one suggestion / grouping request covers (the ML service refuses more than 300).
        maxPhotos: Math.max(1, Math.min(300, numberSetting('OTHER_PLANT_MAX_PHOTOS', 200))),
        // Cosine similarity from which two Other plant photos are put in one group. A STARTING value: it depends on the
        // embedder, so the page lets the admin change it.
        groupThreshold: (() => {
            const n = Number.parseFloat(process.env.OTHER_PLANT_GROUP_THRESHOLD);
            return Number.isFinite(n) ? Math.min(0.99, Math.max(0.5, n)) : 0.8;
        })()
    },
    // Nightly housekeeping (config/maintenance.js): the public-copy reconcile job and the
    // denied-photo retention job. Local time of the server process.
    maintenance: {
        nightlyHour: Math.min(23, numberSetting('NIGHTLY_JOB_HOUR', 3))
    },
    pagination: {
        // Every list route clamps to these instead of hardcoding a page size.
        defaultPageSize: 12,
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
        // Twenty claims is deliberately generous: it still stops one contributor
        // draining a large queue and leaving nothing for anyone else, while never
        // being the reason a capable one cannot work in parallel with others.
        maxClaimPerUsers: numberSetting('DISCOVERIES_MAX_CLAIMS', 20),
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
        // max(2, min(this, ceil(activeContributors / 2))). Five with five
        // contributors is unanimity, and unanimity means one holdout can never save
        // one. The floor of 2 is what stops a single contributor closing a report
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
    // Archive and deletion (config/archive-retention.js). An admin archives a plant, a photo or a
    // description; deleting an archived item only puts it in the DELETED status, and the nightly job
    // removes it for good once it has been there this many days. The admin changes the live number in
    // Settings > Archive & Deletion (system_settings key archiveRetention); this is the fallback.
    archive: {
        retentionDays: Math.min(3650, Math.max(1, numberSetting('ARCHIVE_RETENTION_DAYS', 30))),
        retentionDaysMax: 3650,
        // Most deleted items the nightly job removes in one run; the rest wait for the next night.
        purgeBatchSize: Math.max(1, numberSetting('ARCHIVE_PURGE_BATCH_SIZE', 100))
    },
    // Community feedback on a contributor's plant description (the thumbs up / down
    // on the plant profile). Counted per description, one ballot per account.
    descriptionVotes: {
        // This many UP votes (since an admin last cleared the item) raise a "worth
        // making the primary description" notice on the admin dashboard.
        upvoteAlert: Math.max(1, numberSetting('DESCRIPTION_UPVOTE_ALERT', 5)),
        // This many DOWN votes hide the description from the public page at once and
        // notify the admin, who then restores it or takes it out. At least 2, so a
        // single account can never hide someone else's work alone.
        downvoteHide: Math.max(2, numberSetting('DESCRIPTION_DOWNVOTE_HIDE', 5)),
        // The premade reasons shown in the downvote dropdown. 'other' is the only
        // one that takes the voter's own note. Codes are stored; labels are display.
        reasons: [
            { code: 'inaccurate', label: 'Information is inaccurate' },
            { code: 'unsafe', label: 'Unsafe or misleading advice' },
            { code: 'unclear', label: 'Unclear or poorly written' },
            { code: 'off_topic', label: 'Not about this plant' },
            { code: 'duplicate', label: 'Duplicate of another description' },
            { code: 'spam', label: 'Spam or inappropriate' },
            { code: 'other', label: 'Other (write your own note)' }
        ],
        noteMaxLength: 300
    },
    // Every plant OWNS exactly one plant_types row. The name is free text and may
    // repeat across plants; only typeId is unique. Editing one plant's type can
    // never touch another plant. The toxicity level is the badge colour (green =
    // none, then yellow / orange / red; see public/javascript/badges.js).
    plantTypes: {
        nameMaxLength: 50,
        cautionMaxLength: 1000,
        // Weakest to strongest; the order is the order of the badge colours.
        toxicityLevels: ['none', 'mild', 'moderate', 'severe']
    },
    ml: {
        serviceUrl: process.env.ML_SERVICE_URL || 'http://localhost:8001',
        timeoutMs: parseInt(process.env.ML_TIMEOUT_MS, 10) || 30000,
        defaultModel: process.env.ML_DEFAULT_MODEL || 'efficientnetv2b1',
        // Route code must never hardcode any of these, same rule as
        // settings.plantImages.
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
