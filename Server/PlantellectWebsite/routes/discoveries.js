const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth, requirePermission } = require('../middleware/authMiddleware');
const settings = require('../config/settings');
const { uploadDiscoveryImages, discoveryUploadConfig, handleUploadError } = require('../config/upload');
const {
    createDiscoveryReport,
    getDiscoveryImageForOwner,
    getDiscoveryImageForBotanist,
    listPendingDiscoveries,
    getDiscoveryCounts,
    claimDiscovery,
    unclaimDiscovery,
    releaseDiscovery,
    resolveDiscovery,
    reopenDiscovery,
    disqualifyDiscovery,
    reinstateDisqualified,
    castNotAPlantVote,
    listMyDiscoveryReports,
    getMyDiscoverySummary,
    cancelDiscoveryReport,
    DISQUALIFY_REASONS,
    DISCOVERY_STORAGE_ROOT
} = require('../config/mysql.js');

const router = express.Router();

// ---------------------------------------------------------------------------
// ROUTE ORDER IS A CORRECTNESS PROPERTY, NOT A STYLE.
//
// Every literal segment is registered before every parameterised one. In a
// router mounted at /api/discoveries, a GET '/images/:imageId' and a POST
// '/:requestId/claim' coexist fine, but '/mine' and '/count' share a shape with a
// '/:requestId' route the moment one is added — and '/:requestId' then swallows
// them, answering with a report-not-found for what was really a queue request.
// ---------------------------------------------------------------------------

function discardFiles(files) {
    for (const file of files || []) {
        if (file && file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
    }
}

/**
 * Resolves a storedPath inside the discovery root and refuses anything that
 * escapes it. The path comes from the database row keyed by imageId, so a
 * crafted id cannot traverse — but the guard is kept because the rule is cheap
 * and its absence is a stored-file read primitive.
 */
function resolveInsideDiscoveryRoot(storedPath) {
    const resolved = path.resolve(path.join(DISCOVERY_STORAGE_ROOT, storedPath));
    const root = path.resolve(DISCOVERY_STORAGE_ROOT);
    return resolved.startsWith(root + path.sep) ? resolved : null;
}

// ---------------------------------------------------------------------------
// Filing a report (section I)
// ---------------------------------------------------------------------------

/**
 * POST /api/discoveries — a signed-in account flags a plant the model could not
 * identify.
 *
 * Behind requireAuth only. A `user` has no permission that fits this, and
 * inventing one for a narrow case would grow the matrix for no gain — so the
 * per-account open-report cap (409) and the filing cooldown (429), both enforced
 * in config/mysql.js inside the insert's transaction, are what bound this write
 * path instead.
 *
 * A note OR at least one photo is required: with neither, a report is a scan log
 * and mlscans already holds one.
 */
router.post('/',
    requireAuth,
    uploadDiscoveryImages.array('images', settings.plantImages.maxDiscoveryFiles),
    async (req, res) => {
        const files = req.files || [];
        try {
            const result = await createDiscoveryReport({
                accountId: req.session.accountId,
                note: req.body.note,
                location: req.body.location,
                predictions: parsePredictions(req.body.predictions),
                files
            });
            if (result.error) {
                discardFiles(files);
                if (result.retryAfterSeconds) {
                    // The one place a 429 belongs: the cooldown is a frequency
                    // limit, and Retry-After expresses it directly.
                    res.setHeader('Retry-After', String(result.retryAfterSeconds));
                }
                return res.status(result.code).json(result);
            }
            res.status(201).json({
                requestId: result.requestId,
                imageIds: result.imageIds,
                openReports: result.openReports,
                maxOpenReports: result.maxOpenReports,
                dispatchedTo: result.dispatchedTo,
                message: 'Report filed. A botanist will pick it up from the queue.'
            });
        } catch (err) {
            discardFiles(files);
            console.error('Create discovery report error:', err.message);
            res.status(500).json({ error: 'Failed to file the report' });
        }
    }
);

/** predictions arrive as JSON text; a malformed value is simply no hint at all. */
function parsePredictions(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        return [];
    }
}

// ---------------------------------------------------------------------------
// The reporter's own photo 
// ---------------------------------------------------------------------------

/**
 * GET /api/discoveries/images/:imageId — the OWNER's view.
 *
 * A separate route from the botanist view below, not a widened condition on this
 * one: `requirePermission('record_plant') || accountId match` in a single query
 * is exactly how an owner-only guarantee quietly becomes "anyone who can record
 * can read anyone's report photo".
 *
 * 404 and never 403 on a miss, so the route cannot confirm that someone else's
 * report exists. Cache-Control private, no-store: unlike the public plant image
 * route, this response must never be shared.
 */
router.get('/images/:imageId', requireAuth, async (req, res) => {
    try {
        const image = await getDiscoveryImageForOwner(req.params.imageId, req.session.accountId);
        if (!image) return res.status(404).json({ error: 'Image not found' });
        const resolved = resolveInsideDiscoveryRoot(image.storedPath);
        if (!resolved) return res.status(404).json({ error: 'Image not found' });
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({ error: 'Image file not found on disk' });
        }
        res.setHeader('Content-Type', image.mimeType);
        res.setHeader('Cache-Control', 'private, no-store');
        res.sendFile(resolved);
    } catch (err) {
        console.error('Serve discovery owner image error:', err.message);
        res.status(500).json({ error: 'Failed to load image' });
    }
});

/**
 * GET /api/discoveries/report-images/:imageId — the BOTANIST's view, status-free.
 *
 * A botanist must be able to read the reporter's photo: the reporter is usually
 * a plain `user` who cannot identify a plant, so the photo is the reason the
 * report exists.
 *
 * Distinct path from the owner route on purpose, per the note above. The plan
 * writes this route as '/images/:imageId' in one task and as owner-only in
 * another; two paths resolve it without weakening either guarantee.
 */
router.get('/report-images/:imageId', requirePermission('record_plant'), async (req, res) => {
    try {
        const image = await getDiscoveryImageForBotanist(req.params.imageId);
        if (!image) return res.status(404).json({ error: 'Image not found' });
        const resolved = resolveInsideDiscoveryRoot(image.storedPath);
        if (!resolved) return res.status(404).json({ error: 'Image not found' });
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({ error: 'Image file not found on disk' });
        }
        res.setHeader('Content-Type', image.mimeType);
        // Status-free and private: a report is not a resource anybody may cache.
        res.setHeader('Cache-Control', 'private, no-store');
        res.sendFile(resolved);
    } catch (err) {
        console.error('Serve discovery report image error:', err.message);
        res.status(500).json({ error: 'Failed to load image' });
    }
});

// ---------------------------------------------------------------------------
// The botanist queue (section J)
// ---------------------------------------------------------------------------

/** The closed reason set, so the client never hardcodes it. */
router.get('/reasons', requirePermission('record_plant'), (req, res) => {
    res.json({ reasons: DISQUALIFY_REASONS });
});

/** GET /api/discoveries/count — the sidebar dot, which counts UNCLAIMED. */
router.get('/count', requirePermission('record_plant'), async (req, res) => {
    try {
        res.json(await getDiscoveryCounts());
    } catch (err) {
        console.error('Discovery counts error:', err.message);
        res.status(500).json({ error: 'Failed to load the discovery count' });
    }
});

/** GET /api/discoveries — the queue. A botanist sees only plant_discovery rows. */
router.get('/', requirePermission('record_plant'), async (req, res) => {
    try {
        res.json(await listPendingDiscoveries({
            page: req.query.page,
            pageSize: req.query.pageSize
        }));
    } catch (err) {
        console.error('List discoveries error:', err.message);
        res.status(500).json({ error: 'Failed to load discovery reports' });
    }
});

// ---------------------------------------------------------------------------
// The reporter's own view (section L)
// ---------------------------------------------------------------------------

/**
 * GET /api/discoveries/mine — requireAuth, for ANY signed-in account.
 *
 * A botanist may file reports too, so this must not be gated on record_plant: a
 * section that hid itself for one role would be a second bug.
 */
router.get('/mine', requireAuth, async (req, res) => {
    try {
        res.json(await listMyDiscoveryReports(req.session.accountId, {
            page: req.query.page,
            pageSize: req.query.pageSize
        }));
    } catch (err) {
        console.error('List my discovery reports error:', err.message);
        res.status(500).json({ error: 'Failed to load your reports' });
    }
});

/** GET /api/discoveries/mine/summary — the form's numbers, before submission. */
router.get('/mine/summary', requireAuth, async (req, res) => {
    try {
        res.json(await getMyDiscoverySummary(req.session.accountId));
    } catch (err) {
        console.error('Discovery summary error:', err.message);
        res.status(500).json({ error: 'Failed to load your report summary' });
    }
});

// ---------------------------------------------------------------------------
// Per-report actions
// ---------------------------------------------------------------------------

/**
 * Claim. 200, or 409 naming the current claimer.
 *
 * The conditional UPDATE ... WHERE it is still unheld IS the concurrency story:
 * two botanists racing produce one winner and one clean 409, with no lock table
 * and no FOR UPDATE retry loop.
 */
router.post('/:requestId/claim', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await claimDiscovery(req.params.requestId, req.session.accountId);
        if (result.error) return res.status(result.code).json(result);
        res.json({ message: 'Claimed', ...result });
    } catch (err) {
        console.error('Claim discovery error:', err.message);
        res.status(500).json({ error: 'Failed to claim the report' });
    }
});

/** Unclaim — YOUR OWN claim only. */
router.post('/:requestId/unclaim', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await unclaimDiscovery(req.params.requestId, req.session.accountId);
        if (result.error) return res.status(result.code).json(result);
        res.json({ message: 'Claim released', ...result });
    } catch (err) {
        console.error('Unclaim discovery error:', err.message);
        res.status(500).json({ error: 'Failed to release the claim' });
    }
});

/**
 * Release — admin, or any botanist acting on a claim whose holder is not active.
 * Audited with the actor and the previous holder.
 */
router.post('/:requestId/release', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await releaseDiscovery(
            req.params.requestId,
            req.session.accountId,
            req.session.permissions || []
        );
        if (result.error) return res.status(result.code).json(result);
        res.json({ message: 'Claim released', ...result });
    } catch (err) {
        console.error('Release discovery error:', err.message);
        res.status(500).json({ error: 'Failed to release the claim' });
    }
});

/** Resolve — requires holding the claim, enforced in SQL. */
router.post('/:requestId/resolve', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await resolveDiscovery(req.params.requestId, req.session.accountId);
        if (result.error) return res.status(result.code).json(result);
        res.json({ message: 'Marked resolved', ...result });
    } catch (err) {
        console.error('Resolve discovery error:', err.message);
        res.status(500).json({ error: 'Failed to resolve the report' });
    }
});

/** Reopen — requires HAVING BEEN the one to resolve it, also enforced in SQL. */
router.post('/:requestId/reopen', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await reopenDiscovery(req.params.requestId, req.session.accountId);
        if (result.error) return res.status(result.code).json(result);
        res.json({ message: 'Reopened', ...result });
    } catch (err) {
        console.error('Reopen discovery error:', err.message);
        res.status(500).json({ error: 'Failed to reopen the report' });
    }
});

/** Disqualify — "not a plant". Requires holding the claim. */
router.post('/:requestId/disqualify', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await disqualifyDiscovery(
            req.params.requestId,
            req.session.accountId,
            req.body.reason
        );
        if (result.error) return res.status(result.code).json(result);
        res.json({ message: 'Recorded as not-a-plant', ...result });
    } catch (err) {
        console.error('Disqualify discovery error:', err.message);
        res.status(500).json({ error: 'Failed to record that verdict' });
    }
});

/** Reinstate — open to ANY botanist, unlike reopen which is author-only. */
router.post('/:requestId/reinstate', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await reinstateDisqualified(req.params.requestId, req.session.accountId);
        if (result.error) return res.status(result.code).json(result);
        res.json({ message: 'Reinstated', ...result });
    } catch (err) {
        console.error('Reinstate discovery error:', err.message);
        res.status(500).json({ error: 'Failed to reinstate the report' });
    }
});

/**
 * Vote "not a plant". Does NOT require holding the claim — a vote is an
 * endorsement, not responsibility for the work — and does not consume a claim
 * slot. A LIVE claim closes the vote, because a botanist part-way through a
 * record must not have their work rejected underneath them.
 *
 * 409 below the electorate floor: a stored-but-inert ballot reads as a bug to
 * whoever cast it.
 */
router.post('/:requestId/vote', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await castNotAPlantVote(req.params.requestId, req.session.accountId);
        if (result.error) return res.status(result.code).json(result);
        res.json(result);
    } catch (err) {
        console.error('Cast not-a-plant vote error:', err.message);
        res.status(500).json({ error: 'Failed to record your vote' });
    }
});

/**
 * Cancel — the reporter withdraws their own report.
 *
 * requireAuth + owner, NOT the botanist gate: this belongs to the reporter. The
 * owner predicate lives in the UPDATE, and a miss is 404 so neither another
 * account nor an admin can confirm the report exists.
 */
router.post('/:requestId/cancel', requireAuth, async (req, res) => {
    try {
        const result = await cancelDiscoveryReport(req.params.requestId, req.session.accountId);
        if (result.error) return res.status(result.code).json(result);
        res.json({ message: 'Report withdrawn', ...result });
    } catch (err) {
        console.error('Cancel discovery error:', err.message);
        res.status(500).json({ error: 'Failed to withdraw the report' });
    }
});

// Must stay last: turns a rejected upload into a 400 naming the real limit.
router.use(handleUploadError(discoveryUploadConfig));

module.exports = router;