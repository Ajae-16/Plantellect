const express = require('express');
const path = require('path');
const fs = require('fs');
const { requirePermission } = require('../middleware/authMiddleware');
const settings = require('../config/settings');
const { plantImageUpload, handleUploadError } = require('../config/upload');
const { withdrawMyRequest } = require('../config/withdraw-mysql');
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
    createPlantTaxonomyRequest,
    getRecordingPlant,
    getPlantImageLimits,
    processNewRequest,
    loadAccountPermissions
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

/**
 * A list of ids that may arrive as a real array (JSON body), a JSON string or a
 * comma-separated string (multipart fields). Anything else is an empty list.
 */
function readIdList(raw) {
    if (!raw) return [];
    let list = raw;
    if (typeof raw === 'string') {
        try {
            list = JSON.parse(raw);
        } catch (err) {
            list = raw.split(',');
        }
    }
    if (!Array.isArray(list)) return [];
    return list.map((v) => String(v).trim()).filter(Boolean);
}

function discardFiles(files) {
    for (const file of files || []) {
        if (file && file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
    }
}

// ---------------------------------------------------------------------------
// Who is looking, and what the public plant detail may reveal to them
// ---------------------------------------------------------------------------

const ADMIN_ROLES = ['admin', 'superadmin'];

/**
 * ASSUMPTION (same as routes/botanists.js): roles are on the session. If
 * /api/auth/me gets them another way, change this one function. It fails closed.
 */
function viewerIsAdmin(req) {
    const roles = (req.session && req.session.roles) || [];
    return Array.isArray(roles) && roles.some((r) => ADMIN_ROLES.includes(r));
}

const PEOPLE_FIELDS = ['recordedBy', 'reviewedBy', 'reportedBy'];

const isAdminAccount = (p) =>
    p && typeof p === 'object' &&
    (p.profileType === 'admin' || ADMIN_ROLES.includes(p.role));

const ROLE_PRIORITY = ['superadmin', 'admin', 'botanist'];

/**
 * Fills in `role` for any named person who has an accountId but no role, using
 * the same role lookup the login uses. The server decides the role: the page
 * never works it out from a name or a label.
 *
 * Runs BEFORE redactAdminAccounts, which needs the role to know whose
 * accountId to hide. A failed lookup leaves that person as plain text rather
 * than failing the plant request.
 */
async function enrichPeopleRoles(plant) {
    const cache = new Map();
    const roleFor = (id) => {
        if (!cache.has(id)) {
            cache.set(id, (async () => {
                try {
                    const perms = await loadAccountPermissions(id);
                    const roles = (perms && perms.roles) || [];
                    return ROLE_PRIORITY.find((r) => roles.includes(r)) || null;
                } catch (err) {
                    return null;
                }
            })());
        }
        return cache.get(id);
    };
    const fill = async (p) => {
        if (!p || typeof p !== 'object' || p.role || p.profileType || !p.accountId) return p;
        const role = await roleFor(String(p.accountId));
        return role ? { ...p, role } : p;
    };

    const out = { ...plant };
    for (const key of PEOPLE_FIELDS) {
        const value = out[key];
        if (Array.isArray(value)) out[key] = await Promise.all(value.map(fill));
        else if (value && typeof value === 'object') out[key] = await fill(value);
    }
    return out;
}

/**
 * An administrator's accountId is only useful for building a profile URL, and
 * only administrators may open one. Everyone else gets the name with no id, so
 * the public plant API never carries an administrator profile address.
 */
function redactAdminAccounts(plant, viewerSeesAdmins) {
    if (viewerSeesAdmins) return plant;
    const out = { ...plant };
    const strip = (p) => {
        if (!isAdminAccount(p)) return p;
        const { accountId, ...rest } = p;
        return rest;
    };
    for (const key of PEOPLE_FIELDS) {
        const value = out[key];
        if (Array.isArray(value)) out[key] = value.map(strip);
        else if (value && typeof value === 'object') out[key] = strip(value);
    }
    return out;
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

/**
 * The photo limits the record form should show and enforce client-side. The
 * count is the live admin setting; the client's copy is a courtesy and the upload
 * middleware is the authority. Botanist-only, like the forms that use it.
 */
router.get('/limits', requirePermission('record_plant'), async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await getPlantImageLimits());
    } catch (err) {
        console.error('Get plant image limits error:', err.message);
        res.status(500).json({ error: 'Failed to load upload limits' });
    }
});

/**
 * Does this species already exist, and what does the record form need to know
 * about it? By ?scientificName= or ?plantId=. Registered before /:plantId, which
 * would otherwise swallow "lookup". Botanist-only: unlike the public detail read
 * it also finds plants that have no approved description yet, so it must never be
 * reachable by anyone who cannot record.
 */
router.get('/lookup', requirePermission('record_plant'), async (req, res) => {
    const plantId = typeof req.query.plantId === 'string' ? req.query.plantId.trim() : '';
    const scientificName = typeof req.query.scientificName === 'string' ? req.query.scientificName : '';
    if (!plantId && !scientificName.trim()) {
        return res.status(400).json({ error: 'plantId or scientificName is required' });
    }
    try {
        const plant = await getRecordingPlant({ plantId: plantId || null, scientificName });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ exists: Boolean(plant), plant });
    } catch (err) {
        console.error('Plant lookup error:', err.message);
        res.status(500).json({ error: 'Failed to look the plant up' });
    }
});

router.get('/', async (req, res) => {
    try {
        const result = await listPublicPlants({
            search: req.query.search,
            type: req.query.type,
            page: req.query.page,
            pageSize: req.query.pageSize,
            sort: req.query.sort
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
 * A botanist withdraws their OWN submission while it is still pending. The row stays, as
 * 'cancelled'; its photos are rejected and filed away. Someone else's id answers 404.
 */
router.post('/requests/:requestId/withdraw', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await withdrawMyRequest(req.session.accountId, req.params.requestId);
        if (result.error) return res.status(result.code).json({ error: result.error });
        res.json({ requestId: result.requestId, status: result.status, message: 'Submission withdrawn' });
    } catch (err) {
        console.error('Withdraw request error:', err.message);
        res.status(500).json({ error: 'Failed to withdraw the submission' });
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
        // The answer now depends on who is asking, so it must not be shared-cached.
        res.setHeader('Cache-Control', 'private, no-cache');
        res.setHeader('Vary', 'Cookie');
        // Roles are filled in first; the redaction needs them to hide admin ids.
        res.json(redactAdminAccounts(await enrichPeopleRoles(plant), viewerIsAdmin(req)));
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
router.post('/requests', requirePermission('record_plant'), plantImageUpload(getPlantImageLimits), async (req, res) => {
    const files = req.files || [];
    const submitted = {
        commonName: req.body.commonName,
        scientificName: req.body.scientificName,
        typeName: req.body.typeName,
        isMedicinal: req.body.isMedicinal,
        isHarmful: req.body.isHarmful,
        toxicityLevel: req.body.toxicityLevel,
        cautionNote: req.body.cautionNote,
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
    // Photos taken from the claimed report, copied in as PENDING plant photos.
    const discoveryImageIds = readIdList(req.body.discoveryImageIds);

    // validatePlantDraft normalises the names; what is stored must be what it
    // validated, or scientificName stops matching the model's class list.
    const { errors, warnings, clean } = validatePlantDraft(submitted);
    if (files.length + discoveryImageIds.length > req.uploadMaxFiles) {
        errors.push(`At most ${req.uploadMaxFiles} photos per submission, counting report photos`);
    }
    if (errors.length > 0) {
        discardFiles(files);
        return res.status(400).json({ error: errors.join('; ') });
    }

    const draft = {
        ...clean,
        discoveryRequestId: submitted.discoveryRequestId
    };

    try {
        const result = await createPlantAdditionRequest(req.session.accountId, draft, files, discoveryImageIds);
        if (result.error) {
            discardFiles(files);
            // existingPlantId lets the form turn this into a contribution.
            return res.status(result.code).json({ error: result.error, existingPlantId: result.existingPlantId || null });
        }
        const auto = await runAutoApproval(result.requestId);
        res.status(201).json({
            requestId: result.requestId,
            imageIds: result.imageIds,
            scientificName: draft.scientificName,
            warnings: result.strippedHarmful
                ? [...warnings, 'The caution text was left out because this plant type is marked safe.']
                : warnings,
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
        discardFiles(files);
        console.error('Create plant request error:', err.message);
        res.status(500).json({ error: 'Failed to submit plant' });
    }
});

/**
 * Adds a description, measurements and/or photos to an existing plant. Creates
 * the pending rows plus exactly one plant_contribution request for them.
 */
router.post('/:plantId/contributions', requirePermission('record_plant'),
    plantImageUpload(getPlantImageLimits),
    async (req, res) => {
        const files = req.files || [];
        const discoveryImageIds = readIdList(req.body.discoveryImageIds);
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

        const errors = validateContribution(draft, files.length + discoveryImageIds.length);
        if (files.length + discoveryImageIds.length > req.uploadMaxFiles) {
            errors.push(`At most ${req.uploadMaxFiles} photos per submission, counting report photos`);
        }
        if (errors.length > 0) {
            discardFiles(files);
            return res.status(400).json({ error: errors.join('; ') });
        }

        try {
            const result = await createPlantContributionRequest(
                req.session.accountId,
                req.params.plantId,
                draft,
                files,
                discoveryImageIds
            );
            if (result.error) {
                discardFiles(files);
                return res.status(result.code).json({ error: result.error });
            }
            const auto = await runAutoApproval(result.requestId);
            res.status(201).json({
                requestId: result.requestId,
                imageIds: result.imageIds,
                warnings: result.strippedHarmful
                    ? ['The caution text was left out because this plant type is marked safe.']
                    : [],
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

/**
 * Asks for a change to the taxonomy of a plant that already has one. A separate
 * request from every description and photo submission, on purpose, and never
 * auto-approved: taxonomy has no approval switch, so processNewRequest is not
 * called and an admin always decides.
 */
router.post('/:plantId/taxonomy', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await createPlantTaxonomyRequest(req.session.accountId, req.params.plantId, req.body || {});
        if (result.error) return res.status(result.code).json({ error: result.error });
        res.status(201).json({
            requestId: result.requestId,
            changes: result.changes,
            message: 'Taxonomy update submitted for review'
        });
    } catch (err) {
        console.error('Create taxonomy request error:', err.message);
        res.status(500).json({ error: 'Failed to submit taxonomy update' });
    }
});

// Router-level: turns a rejected upload into a 400 naming the limit instead of
// the flat "Something went wrong!" from index.js. Must stay last.
router.use(handleUploadError(settings.plantImages));

module.exports = router;