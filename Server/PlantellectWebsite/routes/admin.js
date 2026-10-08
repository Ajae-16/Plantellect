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
    getMlCoverage,
    listDiscoveryReports,
    listNotAPlantVoters,
    adminDisqualifyDiscovery,
    getDiscoveryImageForReview,
    mysqlPool,
    DISCOVERY_STORAGE_ROOT
} = require('../config/mysql.js');
const approvalMode = require('../config/approval-mode.js');
const { logAuthEvent } = require('../mongoose-schemas/Authlog');

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
        // `kind` is validated in config/mysql.js against a closed set. It defaults
        // to 'revise' server-side when absent, so an older client — or the plain
        // Deny button that predates the choice — keeps the safe behaviour rather
        // than silently becoming the harsher one.
        const result = await denyPlantRequest(
            req.params.requestId,
            req.session.accountId,
            req.body.note,
            req.body.kind || 'revise'
        );
        if (result.error) return res.status(result.code).json(result);
        res.json({
            message: result.kind === 'reject'
                ? 'Denied. The species was refused, so the discovery report was closed too.'
                : 'Denied',
            ...result
        });
    } catch (err) {
        console.error('Deny plant request error:', err.message);
        res.status(500).json({ error: 'Denial failed' });
    }
});

/**
 * Admin discovery queue. A SEPARATE endpoint from /admin/api/plant-requests, and
 * that split is the whole point: it leaves the plant-requests endpoint exactly as
 * it is, so its two-type contract and its existing row-shape assertion keep
 * passing untouched rather than being widened to make a third request type fit.
 *
 * plantName comes from the top predicted species, because a report genuinely has
 * no plant of its own until its record is approved. `hasDescription` here means
 * "did the reporter leave a note".
 */
router.get('/api/discovery-reports', requirePermission('access_admin'), async (req, res) => {
    try {
        const result = await listDiscoveryReports({
            status: req.query.status,
            page: req.query.page,
            pageSize: req.query.pageSize
        });
        res.json(result);
    } catch (err) {
        console.error('List discovery reports error:', err.message);
        res.status(500).json({ error: 'Failed to load discovery reports' });
    }
});

/**
 * The vote audit. This is the ONLY place voter identities appear — a reporter
 * sees a count, never names.
 */
router.get('/api/discovery-reports/:requestId/votes', requirePermission('access_admin'), async (req, res) => {
    try {
        res.json(await listNotAPlantVoters(req.params.requestId));
    } catch (err) {
        console.error('List discovery votes error:', err.message);
        res.status(500).json({ error: 'Failed to load the votes' });
    }
});

/**
 * The admin override, and the only closure path for a team with fewer than two
 * active botanists (the vote endpoint is 409 below that floor).
 *
 * Its own write on purpose: the botanist disqualify route requires holding the
 * claim, and an admin never does, so reusing it would make the one path that
 * makes the quorum survivable for a small team the one path that never works.
 */
router.post('/api/discovery-reports/:requestId/disqualify', requirePermission('access_admin'), async (req, res) => {
    try {
        const result = await adminDisqualifyDiscovery(
            req.params.requestId,
            req.session.accountId,
            req.body.reason
        );
        if (result.error) return res.status(result.code).json(result);
        res.json({ message: 'Report rejected by an administrator', ...result });
    } catch (err) {
        console.error('Admin disqualify discovery error:', err.message);
        res.status(500).json({ error: 'Failed to close the report' });
    }
});

/**
 * Review-time image preview for a report photo. Status-free, because an admin has
 * to see what they are triaging, and no-store because a rejection changes it.
 */
router.get('/api/discovery-images/:imageId', requirePermission('access_admin'), async (req, res) => {
    try {
        const image = await getDiscoveryImageForReview(req.params.imageId);
        if (!image) return res.status(404).json({ error: 'Image not found' });

        const resolved = path.resolve(path.join(DISCOVERY_STORAGE_ROOT, image.storedPath));
        const root = path.resolve(DISCOVERY_STORAGE_ROOT);
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
        console.error('Discovery review image error:', err.message);
        res.status(500).json({ error: 'Failed to load image' });
    }
});

router.get('/api/plants', requirePermission('access_admin'), async (req, res) => {
    try {
        const result = await listPlants({
            search: req.query.search,
            type: req.query.type,
            // ?taxonomyGap=1 narrows to plants missing any of class / order /
            // family / genus / species. The count for the same filter rides along
            // in the response (taxonomyGapTotal), so the dashboard card and this
            // table are read from one request and cannot disagree.
            taxonomyGap: req.query.taxonomyGap === '1' || req.query.taxonomyGap === 'true',
            page: req.query.page,
            pageSize: req.query.pageSize
        });
        res.json(result);
    } catch (err) {
        console.error('List plants error:', err.message);
        res.status(500).json({ error: 'Failed to load plants' });
    }
});

router.get('/api/approval-modes', requirePermission('access_admin'), async (req, res) => {
    try {
        res.json({
            modes: await approvalMode.listApprovalModes(mysqlPool),
            systemAccountId: approvalMode.systemAccountId(),
            rules: {
                // Both permanent, neither switchable, and both returned so the
                // settings block can say what will NOT happen instead of leaving an
                // admin to infer it.
                rails: [
                    'A discovery report is never approved or denied automatically. Its approval is the approval ' +
                    'of the record it produced, and that record is decided under the switches below.',
                    "A submitter's first submission of a given type is always reviewed by hand."
                ],
                neverDenies: 'Automatic mode never denies anything.',
                ruleVersion: approvalMode.AUTO_RULE_VERSION
            },
            // The rail explains itself, so an admin who switched something on and
            // saw nothing happen is not left guessing whether they broke it.
            railExplanations: {
                discovery:
                    'Reports are decided by approving the record they produced. That record is a ' +
                    'plant_addition or plant_contribution, so it follows its own switch.',
                firstSubmission:
                    'The first submission of a given type by an account is always held for review, so an ' +
                    'unvetted submitter is never published automatically.'
            }
        });
    } catch (err) {
        console.error('List approval modes error:', err.message);
        res.status(500).json({ error: 'Failed to load approval modes' });
    }
});

/**
 * Flips one approval switch.
 *
 * `requestType` is validated against the CLOSED set inside
 * config/approval-mode.js before anything is written, so an arbitrary metaKey can
 * never be created from request input — that endpoint is the only writer of
 * approval switches, and a key the switch list does not know is a switch nobody
 * can read back.
 *
 * No permissions_version bump: no permission changed. Bumping it would invalidate
 * every live session in the system to record one boolean, and the field exists to
 * make RBAC caches correct, not to be a general change counter.
 */
router.post('/api/approval-modes', requirePermission('access_admin'), async (req, res) => {
    const { requestType, enabled } = req.body || {};

    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be true or false' });
    }
    try {
        const result = await approvalMode.setAutoApproval(mysqlPool, requestType, enabled);
        if (result.error) return res.status(result.code).json({ error: result.error });

        // The toggling admin is the author of the SETTING, which is a different
        // fact from being the author of any decision it then causes. Recording the
        // before/after per type is what makes "who turned auto approval on, and
        // when" answerable after the fact.
        await logAuthEvent({
            accountId: req.session.accountId,
            action: 'approval_mode_changed',
            ip: req.ip,
            userAgent: req.get('User-Agent') || '',
            metadata: {
                requestType: result.requestType,
                metaKey: result.metaKey,
                before: result.before,
                after: result.value
            }
        });

        res.json({
            message: `${result.requestType} approval is now ${enabled ? 'automatic' : 'manual'}`,
            requestType: result.requestType,
            metaKey: result.metaKey,
            auto: result.value === '1',
            changed: result.changed
        });
    } catch (err) {
        console.error('Set approval mode error:', err.message);
        res.status(500).json({ error: 'Failed to change approval mode' });
    }
});

/**
 * POST /admin/api/ml/active-model
 * Switch the active ML model at runtime.
 * Body: { "modelId": "efficientnetv2b1" | "convnexttiny" }
 * Validates against available_models from FastAPI /model/info
 * Writes to system_settings with optimistic locking (version column)
 */
router.post('/api/ml/active-model', requirePermission('access_admin'), async (req, res) => {
    const { modelId } = req.body || {};
    if (!modelId || typeof modelId !== 'string') {
        return res.status(400).json({ error: 'modelId is required and must be a string' });
    }

    try {
        // Fetch available models from FastAPI to validate
        const ML_SERVICE_URL = settings.ml.serviceUrl;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), settings.ml.timeoutMs);
        let availableModels = [];
        try {
            const response = await fetch(`${ML_SERVICE_URL}/model/info`, { signal: controller.signal });
            if (response.ok) {
                const data = await response.json();
                availableModels = data.available_models || [];
            }
        } catch (err) {
            console.warn('Could not fetch available models from FastAPI, allowing switch with cached list:', err.message);
        } finally {
            clearTimeout(timeoutId);
        }

        // Validate modelId if we have available_models
        if (availableModels.length > 0 && !availableModels.includes(modelId)) {
            return res.status(400).json({
                error: `Unknown modelId: ${modelId}. Available: ${availableModels.join(', ')}`
            });
        }

        // Write to system_settings with optimistic locking
        const mysql = require('../config/mysql.js');
        const conn = await mysql.mysqlPool.getConnection();
        try {
            await conn.beginTransaction();

            // Read current version
            const [current] = await conn.query(
                'SELECT version FROM system_settings WHERE settingKey = ?',
                ['mlActiveModel']
            );
            if (current.length === 0) {
                await conn.rollback();
                return res.status(500).json({ error: 'mlActiveModel not initialized' });
            }
            const currentVersion = current[0].version;

            // Update with optimistic locking
            const [result] = await conn.query(
                'UPDATE system_settings SET settingValue = ?, version = version + 1, updatedBy = ?, updatedAt = NOW() WHERE settingKey = ? AND version = ?',
                [JSON.stringify({ modelId }), req.session.accountId, 'mlActiveModel', currentVersion]
            );

            if (result.affectedRows === 0) {
                await conn.rollback();
                return res.status(409).json({ error: 'Concurrent modification, please retry' });
            }

            await conn.commit();
            res.json({ message: `Active model switched to ${modelId}`, modelId });
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    } catch (err) {
        console.error('Set active model error:', err.message);
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'ML service timeout' });
        }
        res.status(500).json({ error: 'Failed to switch active model' });
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
