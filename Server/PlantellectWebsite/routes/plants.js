const express = require('express');
const path = require('path');
const fs = require('fs');
const { requirePermission } = require('../middleware/authMiddleware');
const settings = require('../config/settings');
const { uploadPlantImages, handleUploadError } = require('../config/upload');
const {
    listPublicPlants,
    getPublicPlantDetail,
    getImageForServing,
    getImageForOwner,
    listPlantTypes,
    listMyRequests,
    validatePlantDraft,
    validateContribution,
    createPlantAdditionRequest,
    createPlantContributionRequest,
    processNewRequest
} = require('../config/mysql.js');

const router = express.Router();

/**
 * The automatic pass, run AFTER the submission has been committed.
 *
 * Two rules, both about not lying to the submitter:
 *
 *   - A failure here never becomes a failed submission. The request row is already
 *     committed; the caller reports why it was not auto-decided and carries on.
 *   - The 201 message changes when the request was approved immediately, because
 *     "Plant submitted for review" on something that is already published and in
 *     the training set is exactly the kind of quiet wrong the rest of this feature
 *     set is built to avoid.
 */
async function runAutoApproval(requestId) {
    try {
        return await processNewRequest(requestId, { triggeredBy: 'submission' });
    } catch (err) {
        console.error('Automatic approval error:', err.message);
        return { autoDecided: false, reason: `Automatic approval could not run: ${err.message}` };
    }
}

/** Reads a parts block that may arrive as JSON text or form fields. */
function readParts(body) {
    if (!body.parts) return {};
    if (typeof body.parts === 'string') {
        try {
            return JSON.parse(body.parts);
        } catch (err) {
            return {};
        }
    }
    return body.parts;
}

function discardFiles(files) {
    for (const file of files || []) {
        if (file && file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
    }
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

router.get('/types', async (req, res) => {
    try {
        res.json({ types: await listPlantTypes() });
    } catch (err) {
        console.error('List plant types error:', err.message);
        res.status(500).json({ error: 'Failed to load plant types' });
    }
});

router.get('/', async (req, res) => {
    try {
        const result = await listPublicPlants({
            search: req.query.search,
            type: req.query.type,
            page: req.query.page,
            pageSize: req.query.pageSize
        });
        res.json(result);
    } catch (err) {
        console.error('List public plants error:', err.message);
        res.status(500).json({ error: 'Failed to load plants' });
    }
});

router.get('/mine', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await listMyRequests(req.session.accountId, {
            page: req.query.page,
            pageSize: req.query.pageSize
        });
        res.json(result);
    } catch (err) {
        console.error('List my requests error:', err.message);
        res.status(500).json({ error: 'Failed to load your submissions' });
    }
});

/**
 * Serves one of the caller's OWN photos, whatever its review status.
 *
 * Registered directly beneath /mine and BEFORE /:plantId/images/:imageId: both
 * patterns match the same two-segment shape, so /mine/images/pimg_000001 would
 * otherwise be swallowed by the public route with plantId = 'mine' and answered
 * 404 "not approved" — which would be indistinguishable from a broken feature.
 *
 * Cache-Control is no-store, unlike the public route's 24h public cache. The
 * two paths must never share a response: a shared cache holding a private photo
 * for a day is a privacy failure, and public ones are status = 'approved' only.
 */
router.get('/mine/images/:imageId', requirePermission('record_plant'), async (req, res) => {
    try {
        const image = await getImageForOwner(req.params.imageId, req.session.accountId);
        // 404, never 403: a 403 would confirm that someone else's image exists.
        if (!image) return res.status(404).json({ error: 'Image not found' });
        const fullPath = path.join(settings.plantImages.storageDir, image.storedPath);
        const resolved = path.resolve(fullPath);
        const root = path.resolve(settings.plantImages.storageDir);
        if (!resolved.startsWith(root + path.sep)) {
            return res.status(404).json({ error: 'Image not found' });
        }
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({ error: 'Image file not found on disk' });
        }
        res.setHeader('Content-Type', image.mimeType);
        res.setHeader('Cache-Control', 'private, no-store');
        res.sendFile(resolved);
    } catch (err) {
        console.error('Serve owner image error:', err.message);
        res.status(500).json({ error: 'Failed to load image' });
    }
});

/**
 * Serves an approved image. The path comes from the database row keyed by
 * imageId, so a crafted id cannot traverse outside the storage directory.
 *
 * Approved-only, deliberately immutable: this route is NOT made session-aware,
 * or a pending photo would become publicly cacheable.
 */
router.get('/:plantId/images/:imageId', async (req, res) => {
    try {
        const image = await getImageForServing(req.params.imageId);
        if (!image || image.plantId !== req.params.plantId) {
            return res.status(404).json({ error: 'Image not found' });
        }
        const fullPath = path.join(settings.plantImages.storageDir, image.storedPath);
        const resolved = path.resolve(fullPath);
        const root = path.resolve(settings.plantImages.storageDir);
        if (!resolved.startsWith(root + path.sep)) {
            return res.status(404).json({ error: 'Image not found' });
        }
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({ error: 'Image file not found on disk' });
        }
        res.setHeader('Content-Type', image.mimeType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(resolved);
    } catch (err) {
        console.error('Serve image error:', err.message);
        res.status(500).json({ error: 'Failed to load image' });
    }
});

router.get('/:plantId', async (req, res) => {
    try {
        const plant = await getPublicPlantDetail(req.params.plantId);
        if (!plant) return res.status(404).json({ error: 'Plant not found' });
        res.json(plant);
    } catch (err) {
        console.error('Get plant detail error:', err.message);
        res.status(500).json({ error: 'Failed to load plant' });
    }
});

// ---------------------------------------------------------------------------
// Botanist submissions
// ---------------------------------------------------------------------------

/**
 * Submits a brand-new plant. The draft is validated but deliberately not
 * checked against existing species: a duplicate is accepted here and converted
 * into a contribution at approval time.
 */
router.post('/requests', requirePermission('record_plant'), async (req, res) => {
    const submitted = {
        commonName: req.body.commonName,
        scientificName: req.body.scientificName,
        typeId: req.body.typeId,
        quantity: req.body.quantity === '' || req.body.quantity === undefined ? null : req.body.quantity,
        kingdom: req.body.kingdom,
        phylum: req.body.phylum,
        plantClass: req.body.plantClass,
        order: req.body.order,
        family: req.body.family,
        genus: req.body.genus,
        species: req.body.species,
        parts: readParts(req.body),
        uses: req.body.uses,
        benefits: req.body.benefits,
        harmful: req.body.harmful,
        // Set when the botanist arrived from a claimed discovery report. It is
        // carried in the payload (provenance: an admin can see from the plant side
        // where a record came from) and it makes the server verify the CLAIM in the
        // same transaction as the insert — the client's "view only" card is not an
        // authority.
        discoveryRequestId: req.body.discoveryRequestId || null
    };

    // validatePlantDraft normalises the names; what is stored must be what it
    // validated, or scientificName stops matching the model's class list.
    const { errors, warnings, clean } = validatePlantDraft(submitted);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join('; ') });
    }

    const draft = {
        ...clean,
        typeId: submitted.typeId,
        discoveryRequestId: submitted.discoveryRequestId
    };

    try {
        const result = await createPlantAdditionRequest(req.session.accountId, draft);
        if (result.error) return res.status(result.code).json({ error: result.error });
        const auto = await runAutoApproval(result.requestId);
        res.status(201).json({
            requestId: result.requestId,
            scientificName: draft.scientificName,
            warnings,
            // Surfaced, not swallowed: a botanist who sees "Approved automatically"
            // learns that no human read their text, and one who sees the rail's
            // reason learns that somebody will.
            autoApproved: auto.autoDecided === true,
            autoSkipReason: auto.autoDecided ? null : (auto.reason || null),
            message: auto.autoDecided
                ? 'Plant approved automatically (no human review)'
                : 'Plant submitted for review'
        });
    } catch (err) {
        console.error('Create plant request error:', err.message);
        res.status(500).json({ error: 'Failed to submit plant' });
    }
});

/**
 * Adds a description, measurements and/or photos to an existing plant. Creates
 * the pending rows plus exactly one plant_contribution request for them.
 */
router.post('/:plantId/contributions', requirePermission('record_plant'),
    uploadPlantImages.array('images', settings.plantImages.maxFilesPerRequest),
    async (req, res) => {
        const files = req.files || [];
        const draft = {
            parts: readParts(req.body),
            uses: req.body.uses,
            benefits: req.body.benefits,
            harmful: req.body.harmful,
            // Same claim verification as POST /requests. A contribution made from
            // a claimed report links it the same way, so a report cannot end up
            // holding a record nobody is allowed to have made.
            discoveryRequestId: req.body.discoveryRequestId || null
        };

        const errors = validateContribution(draft, files.length);
        if (errors.length > 0) {
            discardFiles(files);
            return res.status(400).json({ error: errors.join('; ') });
        }

        try {
            const result = await createPlantContributionRequest(
                req.session.accountId,
                req.params.plantId,
                draft,
                files
            );
            if (result.error) {
                discardFiles(files);
                return res.status(result.code).json({ error: result.error });
            }
            const auto = await runAutoApproval(result.requestId);
            res.status(201).json({
                requestId: result.requestId,
                imageIds: result.imageIds,
                autoApproved: auto.autoDecided === true,
                autoSkipReason: auto.autoDecided ? null : (auto.reason || null),
                message: auto.autoDecided
                    ? 'Contribution approved automatically (no human review)'
                    : 'Contribution submitted for review'
            });
        } catch (err) {
            discardFiles(files);
            console.error('Create plant contribution error:', err.message);
            res.status(500).json({ error: 'Failed to submit contribution' });
        }
    });

// Router-level: turns a rejected upload into a 400 naming the limit instead of
// the flat "Something went wrong!" from index.js. Must stay last.
router.use(handleUploadError(settings.plantImages));

module.exports = router;
