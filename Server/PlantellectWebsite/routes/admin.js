const express = require('express');
const path = require('path');
const fs = require('fs');
const { requirePermission } = require('../middleware/authMiddleware');
const settings = require('../config/settings');
const {
    listUsers,
    setAccountStatus,
    changeAccountRole,
    listPlantRequests,
    getRequestDetail,
    approvePlantRequest,
    denyPlantRequest,
    listPlants,
    listPendingRoleRequests,
    getImageForReview,
    getMlCoverage
} = require('../config/mysql.js');

const router = express.Router();

// ---------------------------------------------------------------------------
// HTML pages. JSON lives under /api so the two never collide on one path.
// ---------------------------------------------------------------------------

const adminDir = path.join(__dirname, '..', 'administration', 'admin');

router.get('/dashboard', requirePermission('access_admin'), (req, res) => {
    res.sendFile(path.join(adminDir, 'admin-dashboard.html'));
});

router.get('/users', requirePermission('access_admin'), (req, res) => {
    res.sendFile(path.join(adminDir, 'admin-user.html'));
});

router.get('/plants', requirePermission('access_admin'), (req, res) => {
    res.sendFile(path.join(adminDir, 'admin-plants.html'));
});

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------

router.get('/api/users', requirePermission('access_admin'), async (req, res) => {
    try {
        const result = await listUsers({
            search: req.query.search,
            role: req.query.role,
            status: req.query.status,
            page: req.query.page,
            pageSize: req.query.pageSize
        });
        res.json(result);
    } catch (err) {
        console.error('List users error:', err.message);
        res.status(500).json({ error: 'Failed to load users' });
    }
});

router.patch('/api/users/:accountId/status', requirePermission('access_admin'), async (req, res) => {
    const { status } = req.body;
    if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({ error: 'status must be "active" or "inactive"' });
    }
    try {
        const result = await setAccountStatus(req.params.accountId, status, req.session.accountId);
        if (result.error) return res.status(result.code).json({ error: result.error });
        res.json(result);
    } catch (err) {
        console.error('Set account status error:', err.message);
        res.status(500).json({ error: 'Failed to change account status' });
    }
});

router.post('/api/users/:accountId/role', requirePermission('access_admin'), async (req, res) => {
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: 'role is required' });
    try {
        const result = await changeAccountRole(
            req.params.accountId,
            role,
            req.session.permissions,
            req.session.accountId
        );
        if (result.error) return res.status(result.code).json({ error: result.error });
        res.json(result);
    } catch (err) {
        console.error('Change account role error:', err.message);
        res.status(500).json({ error: 'Failed to change role' });
    }
});

router.get('/api/role-requests', requirePermission('access_admin'), async (req, res) => {
    try {
        const requests = await listPendingRoleRequests();
        res.json({ requests });
    } catch (err) {
        console.error('List role requests error:', err.message);
        res.status(500).json({ error: 'Failed to load role requests' });
    }
});

router.get('/api/plant-requests', requirePermission('access_admin'), async (req, res) => {
    try {
        const result = await listPlantRequests({
            requestType: req.query.requestType,
            page: req.query.page,
            pageSize: req.query.pageSize
        });
        res.json(result);
    } catch (err) {
        console.error('List plant requests error:', err.message);
        res.status(500).json({ error: 'Failed to load plant requests' });
    }
});

router.get('/api/plant-requests/:requestId', requirePermission('access_admin'), async (req, res) => {
    try {
        const detail = await getRequestDetail(req.params.requestId);
        if (!detail) return res.status(404).json({ error: 'Request not found' });
        res.json(detail);
    } catch (err) {
        console.error('Get plant request error:', err.message);
        res.status(500).json({ error: 'Failed to load request' });
    }
});

/**
 * Review-time image preview. Unlike the public route this serves pending and
 * rejected images too, because that is exactly what an admin must see before
 * approving. Admin-only, and the path still resolves from the database row.
 */
router.get('/api/plant-images/:imageId', requirePermission('access_admin'), async (req, res) => {
    try {
        const image = await getImageForReview(req.params.imageId);
        if (!image) return res.status(404).json({ error: 'Image not found' });

        const resolved = path.resolve(path.join(settings.plantImages.storageDir, image.storedPath));
        const root = path.resolve(settings.plantImages.storageDir);
        if (!resolved.startsWith(root + path.sep)) {
            return res.status(404).json({ error: 'Image not found' });
        }
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({ error: 'Image file not found on disk' });
        }

        res.setHeader('Content-Type', image.mimeType);
        // Review previews must not be cached: a rejection changes what is shown.
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(resolved);
    } catch (err) {
        console.error('Review image error:', err.message);
        res.status(500).json({ error: 'Failed to load image' });
    }
});

router.post('/api/plant-requests/:requestId/approve', requirePermission('access_admin'), async (req, res) => {
    try {
        const result = await approvePlantRequest(
            req.params.requestId,
            req.session.accountId,
            req.body.note
        );
        if (result.error) return res.status(result.code).json({ error: result.error });
        res.json({
            message: result.converted
                ? 'Approved. The species already existed, so the submission was attached to it.'
                : 'Approved',
            ...result
        });
    } catch (err) {
        console.error('Approve plant request error:', err.message);
        res.status(500).json({ error: 'Approval failed' });
    }
});

router.post('/api/plant-requests/:requestId/deny', requirePermission('access_admin'), async (req, res) => {
    try {
        const result = await denyPlantRequest(
            req.params.requestId,
            req.session.accountId,
            req.body.note
        );
        if (result.error) return res.status(result.code).json({ error: result.error });
        res.json({ message: 'Denied', ...result });
    } catch (err) {
        console.error('Deny plant request error:', err.message);
        res.status(500).json({ error: 'Denial failed' });
    }
});

router.get('/api/plants', requirePermission('access_admin'), async (req, res) => {
    try {
        const result = await listPlants({
            search: req.query.search,
            type: req.query.type,
            page: req.query.page,
            pageSize: req.query.pageSize
        });
        res.json(result);
    } catch (err) {
        console.error('List plants error:', err.message);
        res.status(500).json({ error: 'Failed to load plants' });
    }
});

router.get('/api/ml/coverage', requirePermission('access_admin'), async (req, res) => {
    try {
        const classes = loadClasses();
        if (!classes) {
            return res.status(200).json({
                error: 'classes.json not found or unreadable',
                matched: [], plantsOnly: [], classesOnly: []
            });
        }
        const coverage = await getMlCoverage(classes);
        res.json({ ...coverage, classCount: classes.length });
    } catch (err) {
        console.error('ML coverage error:', err.message);
        res.status(500).json({ error: 'Failed to compute coverage' });
    }
});

/** Reads the trained model's class list, or null when it is not available. */
function loadClasses() {
    const classesPath = path.join(__dirname, '..', 'ml', 'model', 'main', 'classes.json');
    try {
        if (!fs.existsSync(classesPath)) return null;
        const parsed = JSON.parse(fs.readFileSync(classesPath, 'utf8'));
        const values = Array.isArray(parsed) ? parsed : Object.values(parsed);
        return values
            .map((v) => (typeof v === 'string' ? { scientific: v, common: v } : v))
            .filter((v) => v && v.scientific);
    } catch (err) {
        console.error('Could not read classes.json:', err.message);
        return null;
    }
}

module.exports = router;
