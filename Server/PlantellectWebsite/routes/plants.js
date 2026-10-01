const express = require('express');
const path = require('path');
const fs = require('fs');
const { requirePermission } = require('../middleware/authMiddleware');
const settings = require('../config/settings');
const { uploadPlantImages } = require('../config/upload');
const {
    listPublicPlants,
    getPublicPlantDetail,
    getImageForServing,
    listPlantTypes,
    listMyRequests,
    validatePlantDraft,
    validateContribution,
    createPlantAdditionRequest,
    createPlantContributionRequest
} = require('../config/mysql.js');

const router = express.Router();

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
 * Serves an approved image. The path comes from the database row keyed by
 * imageId, so a crafted id cannot traverse outside the storage directory.
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
    const draft = {
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
        harmful: req.body.harmful
    };

    const errors = validatePlantDraft(draft);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join('; ') });
    }

    try {
        const result = await createPlantAdditionRequest(req.session.accountId, draft);
        if (result.error) return res.status(result.code).json({ error: result.error });
        res.status(201).json({
            requestId: result.requestId,
            message: 'Plant submitted for review'
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
            harmful: req.body.harmful
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
            res.status(201).json({
                requestId: result.requestId,
                imageIds: result.imageIds,
                message: 'Contribution submitted for review'
            });
        } catch (err) {
            discardFiles(files);
            console.error('Create plant contribution error:', err.message);
            res.status(500).json({ error: 'Failed to submit contribution' });
        }
    });

module.exports = router;
