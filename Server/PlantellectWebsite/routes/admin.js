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
    getSystemSetting,
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

router.get('/settings', requirePermission('access_admin'), (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'administration', 'admin', 'admin-settings.html'));
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

router.get('/api/approval-modes', requirePermission('admin_settings'), async (req, res) => {
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
router.post('/api/approval-modes', requirePermission('admin_settings'), async (req, res) => {
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
 * Also notifies FastAPI to reload the model (if endpoint exists)
 */
router.post('/api/ml/active-model', requirePermission('admin_settings'), async (req, res) => {
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
                // Normalize available_models: FastAPI may return objects like {id, name, ...}
                const modelIdOf = (m) =>
                    typeof m === 'string' ? m : (m && (m.id || m.modelId || m.model_id || m.name)) || '';
                availableModels = (data.available_models || []).map(modelIdOf).filter(Boolean);
            }
        } catch (err) {
            console.warn('Could not fetch available models from FastAPI:', err.message);
        } finally {
            clearTimeout(timeoutId);
        }

        // Must have available_models to validate - reject if ML service unreachable
        if (availableModels.length === 0) {
            return res.status(503).json({ error: 'ML service unreachable, cannot verify the model' });
        }
        if (!availableModels.includes(modelId)) {
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
        const classes = await loadClasses();
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

/** Reads the trained model's class list from the ACTIVE model's folder, or null when not available. */
async function loadClasses() {
    let modelId = '';
    try {
        let value = await getSystemSetting('mlActiveModel');
        if (typeof value === 'string') {
            try { value = JSON.parse(value); } catch (_) { /* bare id */ }
        }
        modelId = typeof value === 'string' ? value : (value && value.modelId) || '';
    } catch (err) {
        console.error('mlActiveModel read failed:', err.message);
    }
    modelId = path.basename(modelId || settings.ml.defaultModel || 'efficientnetv2b1');

    const classesPath = path.join(__dirname, '..', 'ml', 'model', modelId, 'classes.json');
    try {
        if (!fs.existsSync(classesPath)) return null;
        const parsed = JSON.parse(fs.readFileSync(classesPath, 'utf8'));
        const values = Array.isArray(parsed) ? parsed : Object.values(parsed);
        return values
            .map((v) => (typeof v === 'string' ? { scientific: v, common: v } : v))
            .filter((v) => v && v.scientific && (v.kind || 'species') === 'species');
    } catch (err) {
        console.error('Could not read classes.json:', err.message);
        return null;
    }
}

/**
 * GET /admin/api/settings
 * Consolidated endpoint returning all admin settings at once.
 * Uses per-key optimistic locking via version column.
 */
router.get('/api/settings', requirePermission('admin_settings'), async (req, res) => {
    try {
        const conn = await mysqlPool.getConnection();
        try {
            const keys = ['mlActiveModel', 'mlConfidence', 'discoveries', 'mlRequest'];
            const settings = {};

            for (const key of keys) {
                const [rows] = await conn.query(
                    'SELECT settingValue, version FROM system_settings WHERE settingKey = ?',
                    [key]
                );
                if (rows.length > 0) {
                    let value = rows[0].settingValue;
                    if (typeof value === 'string') {
                        try {
                            value = JSON.parse(value);
                        } catch (_) {
                        }
                    }
                    settings[key] = {
                        value,
                        version: rows[0].version
                    };
                }
            }

            // Ensure all keys exist with defaults
            if (!settings.mlActiveModel) settings.mlActiveModel = { value: { modelId: 'efficientnetv2b1' }, version: 0 };
            if (!settings.mlConfidence) settings.mlConfidence = {
                value: {
                    efficientnetv2b1: { mode: 'off', acceptThreshold: 0.70, uncertainThreshold: 0.35, marginThreshold: 0.15 },
                    convnexttiny: { mode: 'off', acceptThreshold: 0.70, uncertainThreshold: 0.35, marginThreshold: 0.15 }
                },
                version: 0
            };
            if (!settings.discoveries) settings.discoveries = {
                value: {
                    maxClaimsPerBotanist: 20,
                    maxOpenReportsPerAccount: 10,
                    cancelGraceHours: 24,
                    reportCooldownMinutes: 10,
                    claimStaleDays: 90,
                    notAPlantVotes: 5,
                    discoveryClosedPhotoDays: 90
                },
                version: 0
            };
            if (!settings.mlRequest) settings.mlRequest = { value: { maxTopK: 10 }, version: 0 };

            // Return settings with versions as separate top-level keys
            const response = {};
            for (const key of keys) {
                response[key] = settings[key].value;
                response[key + 'Version'] = settings[key].version;
            }

            res.json(response);
        } finally {
            conn.release();
        }
    } catch (err) {
        console.error('Get settings error:', err.message);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

const { validateConfig } = require('../config/ml-confidence.js');

/**
 * Fetch available model IDs from FastAPI /model/info.
 * Called before the transaction so we don't hold a DB connection during the HTTP call.
 */
async function fetchAvailableModelIds() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), settings.ml.timeoutMs);
    try {
        const response = await fetch(`${settings.ml.serviceUrl}/model/info`, { signal: controller.signal });
        if (!response.ok) return [];
        const data = await response.json();
        const idOf = (m) => typeof m === 'string' ? m : (m && (m.id || m.modelId || m.model_id || m.name)) || '';
        return (data.available_models || []).map(idOf).filter(Boolean);
    } catch (err) {
        console.warn('Could not fetch available models from FastAPI:', err.message);
        return [];
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * POST /admin/api/settings
 * Consolidated endpoint for updating settings with per-key optimistic locking.
 * Accepts partial updates: { mlConfidence: { efficientnetv2b1: {...} }, discoveries: {...} }
 * Returns updated settings with new versions.
 */
router.post('/api/settings', requirePermission('admin_settings'), async (req, res) => {
    const updates = req.body || {};
    if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No settings provided' });
    }

    const allowedKeys = ['mlActiveModel', 'mlConfidence', 'discoveries', 'mlRequest'];
    const invalidKeys = Object.keys(updates).filter(k => !allowedKeys.includes(k));
    if (invalidKeys.length > 0) {
        return res.status(400).json({ error: `Invalid setting keys: ${invalidKeys.join(', ')}` });
    }

    // Fetch available model IDs from FastAPI BEFORE the transaction (if mlConfidence is being updated)
    const knownModels = updates.mlConfidence ? await fetchAvailableModelIds() : [];

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const results = {};

        for (const [key, value] of Object.entries(updates)) {
            // Read current version and existing value
            const [current] = await conn.query(
                'SELECT settingValue, version FROM system_settings WHERE settingKey = ?',
                [key]
            );

            let currentVersion;
            let existingValue = {};
            if (current.length === 0) {
                // Key doesn't exist - seed it with defaults and start at version 1
                let defaultValue = {};
                if (key === 'mlActiveModel') defaultValue = { modelId: 'efficientnetv2b1' };
                else if (key === 'mlConfidence') defaultValue = {
                    efficientnetv2b1: { mode: 'off', acceptThreshold: 0.70, uncertainThreshold: 0.35, marginThreshold: 0.15 },
                    convnexttiny: { mode: 'off', acceptThreshold: 0.70, uncertainThreshold: 0.35, marginThreshold: 0.15 }
                };
                else if (key === 'discoveries') defaultValue = {
                    maxClaimsPerBotanist: 20,
                    maxOpenReportsPerAccount: 10,
                    cancelGraceHours: 24,
                    reportCooldownMinutes: 10,
                    claimStaleDays: 90,
                    notAPlantVotes: 5,
                    discoveryClosedPhotoDays: 90
                };
                else if (key === 'mlRequest') defaultValue = { maxTopK: 10 };

                await conn.query(
                    'INSERT INTO system_settings (settingKey, settingValue, version) VALUES (?, ?, 1)',
                    [key, JSON.stringify(defaultValue)]
                );
                currentVersion = 1;
                existingValue = defaultValue;
            } else {
                currentVersion = current[0].version;
                existingValue = current[0].settingValue;
                if (typeof existingValue === 'string') {
                    try { existingValue = JSON.parse(existingValue); } catch (_) { existingValue = {}; }
                }
            }

            // Validate based on key
            let validatedValue = value;
            if (key === 'mlConfidence') {
                // Reject non-object config (e.g., { convnexttiny: 5 })
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    await conn.rollback();
                    return res.status(400).json({ error: 'mlConfidence must be an object' });
                }
                // Models the ML service has loaded, plus any that already have a saved entry
                const allowed = new Set([...knownModels, ...Object.keys(existingValue || {})]);
                for (const [modelId, config] of Object.entries(value)) {
                    if (!allowed.has(modelId)) {
                        await conn.rollback();
                        return res.status(400).json({ error: `Unknown model: ${modelId}. Available: ${[...allowed].join(', ')}` });
                    }
                    // Reject non-object config (e.g., { convnexttiny: 5 })
                    if (!config || typeof config !== 'object' || Array.isArray(config)) {
                        await conn.rollback();
                        return res.status(400).json({ error: `${modelId}: settings must be an object` });
                    }
                    // Merge with saved config first (so partial updates keep mode), then coerce numeric strings
                    const merged = { ...(existingValue[modelId] || {}), ...config };
                    const NUMERIC = ['acceptThreshold', 'uncertainThreshold', 'marginThreshold'];
                    for (const k of NUMERIC) {
                        if (typeof merged[k] === 'string' && merged[k].trim() !== '') {
                            merged[k] = Number(merged[k]);
                        }
                    }
                    const check = validateConfig(merged);
                    if (!check.ok) {
                        await conn.rollback();
                        return res.status(400).json({ error: `${modelId}: ${check.errors.join('; ')}` });
                    }
                    value[modelId] = check.value;
                }
                validatedValue = { ...existingValue, ...value };
            } else if (key === 'discoveries') {
                const disc = value;
                if (disc.maxClaimsPerBotanist !== undefined) {
                    const v = parseInt(disc.maxClaimsPerBotanist, 10);
                    if (!Number.isFinite(v) || v < 1 || v > 1000) {
                        await conn.rollback();
                        return res.status(400).json({ error: 'maxClaimsPerBotanist must be 1-1000' });
                    }
                }
                if (disc.maxOpenReportsPerAccount !== undefined) {
                    const v = parseInt(disc.maxOpenReportsPerAccount, 10);
                    if (!Number.isFinite(v) || v < 1 || v > 1000) {
                        await conn.rollback();
                        return res.status(400).json({ error: 'maxOpenReportsPerAccount must be 1-1000' });
                    }
                }
                if (disc.cancelGraceHours !== undefined) {
                    const v = parseInt(disc.cancelGraceHours, 10);
                    if (!Number.isFinite(v) || v < 0 || v > 8760) {
                        await conn.rollback();
                        return res.status(400).json({ error: 'cancelGraceHours must be 0-8760' });
                    }
                }
                if (disc.reportCooldownMinutes !== undefined) {
                    const v = parseInt(disc.reportCooldownMinutes, 10);
                    if (!Number.isFinite(v) || v < 0 || v > 10080) {
                        await conn.rollback();
                        return res.status(400).json({ error: 'reportCooldownMinutes must be 0-10080' });
                    }
                }
                if (disc.claimStaleDays !== undefined) {
                    const v = parseInt(disc.claimStaleDays, 10);
                    if (!Number.isFinite(v) || v < 1 || v > 365) {
                        await conn.rollback();
                        return res.status(400).json({ error: 'claimStaleDays must be 1-365' });
                    }
                }
                if (disc.notAPlantVotes !== undefined) {
                    const v = parseInt(disc.notAPlantVotes, 10);
                    if (!Number.isFinite(v) || v < 2 || v > 100) {
                        await conn.rollback();
                        return res.status(400).json({ error: 'notAPlantVotes must be 2-100' });
                    }
                }
                if (disc.discoveryClosedPhotoDays !== undefined) {
                    const v = parseInt(disc.discoveryClosedPhotoDays, 10);
                    if (!Number.isFinite(v) || v < 1 || v > 365) {
                        await conn.rollback();
                        return res.status(400).json({ error: 'discoveryClosedPhotoDays must be 1-365' });
                    }
                }
                // MERGE for discoveries too
                validatedValue = { ...existingValue, ...value };
            } else if (key === 'mlRequest') {
                if (value.maxTopK !== undefined) {
                    const v = parseInt(value.maxTopK, 10);
                    if (!Number.isFinite(v) || v < 1 || v > 100) {
                        await conn.rollback();
                        return res.status(400).json({ error: 'maxTopK must be 1-100' });
                    }
                }
                validatedValue = { ...existingValue, ...value };
            } else if (key === 'mlActiveModel') {
                if (!value.modelId || typeof value.modelId !== 'string') {
                    await conn.rollback();
                    return res.status(400).json({ error: 'modelId is required and must be a string' });
                }
                validatedValue = value;
            }

            // Update with optimistic locking
            const [result] = await conn.query(
                'UPDATE system_settings SET settingValue = ?, version = version + 1, updatedBy = ?, updatedAt = NOW() WHERE settingKey = ? AND version = ?',
                [JSON.stringify(validatedValue), req.session.accountId, key, currentVersion]
            );

            if (result.affectedRows === 0) {
                await conn.rollback();
                return res.status(409).json({
                    error: `Concurrent modification for ${key}, please retry`,
                    key,
                    serverVersion: currentVersion
                });
            }

            // Read back updated value
            const [updated] = await conn.query(
                'SELECT settingValue, version FROM system_settings WHERE settingKey = ?',
                [key]
            );
            let updatedValue = updated[0].settingValue;
            if (typeof updatedValue === 'string') {
                try { updatedValue = JSON.parse(updatedValue); } catch (_) {}
            }
            results[key] = { value: updatedValue, version: updated[0].version };
        }

        await conn.commit();
        res.json(results);
    } catch (err) {
        await conn.rollback();
        console.error('Update settings error:', err.message);
        res.status(500).json({ error: 'Failed to update settings' });
    } finally {
        conn.release();
    }
});

/**
 * POST /admin/api/discoveries
 * Update discovery settings caps.
 */
router.post('/api/discoveries', requirePermission('admin_settings'), async (req, res) => {
    const settings = req.body || {};
    if (!settings || typeof settings !== 'object') {
        return res.status(400).json({ error: 'Invalid settings object' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [current] = await conn.query(
            'SELECT version FROM system_settings WHERE settingKey = ?',
            ['discoveries']
        );
        if (current.length === 0) {
            await conn.rollback();
            return res.status(500).json({ error: 'discoveries not initialized' });
        }
        const currentVersion = current[0].version;

        // Validate
        const disc = settings;
        if (disc.maxClaimsPerBotanist !== undefined) {
            const v = parseInt(disc.maxClaimsPerBotanist, 10);
            if (!Number.isFinite(v) || v < 1 || v > 1000) {
                await conn.rollback();
                return res.status(400).json({ error: 'maxClaimsPerBotanist must be 1-1000' });
            }
        }
        if (disc.maxOpenReportsPerAccount !== undefined) {
            const v = parseInt(disc.maxOpenReportsPerAccount, 10);
            if (!Number.isFinite(v) || v < 1 || v > 1000) {
                await conn.rollback();
                return res.status(400).json({ error: 'maxOpenReportsPerAccount must be 1-1000' });
            }
        }
        if (disc.cancelGraceHours !== undefined) {
            const v = parseInt(disc.cancelGraceHours, 10);
            if (!Number.isFinite(v) || v < 0 || v > 8760) {
                await conn.rollback();
                return res.status(400).json({ error: 'cancelGraceHours must be 0-8760' });
            }
        }
        if (disc.reportCooldownMinutes !== undefined) {
            const v = parseInt(disc.reportCooldownMinutes, 10);
            if (!Number.isFinite(v) || v < 0 || v > 10080) {
                await conn.rollback();
                return res.status(400).json({ error: 'reportCooldownMinutes must be 0-10080' });
            }
        }
        if (disc.claimStaleDays !== undefined) {
            const v = parseInt(disc.claimStaleDays, 10);
            if (!Number.isFinite(v) || v < 1 || v > 365) {
                await conn.rollback();
                return res.status(400).json({ error: 'claimStaleDays must be 1-365' });
            }
        }
        if (disc.notAPlantVotes !== undefined) {
            const v = parseInt(disc.notAPlantVotes, 10);
            if (!Number.isFinite(v) || v < 2 || v > 100) {
                await conn.rollback();
                return res.status(400).json({ error: 'notAPlantVotes must be 2-100' });
            }
        }
        if (disc.discoveryClosedPhotoDays !== undefined) {
            const v = parseInt(disc.discoveryClosedPhotoDays, 10);
            if (!Number.isFinite(v) || v < 1 || v > 365) {
                await conn.rollback();
                return res.status(400).json({ error: 'discoveryClosedPhotoDays must be 1-365' });
            }
        }

        // Merge with existing
        const [existing] = await conn.query('SELECT settingValue FROM system_settings WHERE settingKey = ?', ['discoveries']);
        let existingValue = existing[0]?.settingValue || '{}';
        if (typeof existingValue === 'string') {
            try { existingValue = JSON.parse(existingValue); } catch (_) { existingValue = {}; }
        }
        const mergedValue = { ...existingValue, ...disc };

        const [result] = await conn.query(
            'UPDATE system_settings SET settingValue = ?, version = version + 1, updatedBy = ?, updatedAt = NOW() WHERE settingKey = ? AND version = ?',
            [JSON.stringify(mergedValue), req.session.accountId, 'discoveries', currentVersion]
        );

        if (result.affectedRows === 0) {
            await conn.rollback();
            return res.status(409).json({ error: 'Concurrent modification, please retry' });
        }

        await conn.commit();

        const [updated] = await conn.query('SELECT settingValue, version FROM system_settings WHERE settingKey = ?', ['discoveries']);
        let updatedValue = updated[0].settingValue;
        if (typeof updatedValue === 'string') {
            try { updatedValue = JSON.parse(updatedValue); } catch (_) {}
        }
        res.json({ value: updatedValue, version: updated[0].version });
    } catch (err) {
        await conn.rollback();
        console.error('Update discoveries settings error:', err.message);
        res.status(500).json({ error: 'Failed to update discovery settings' });
    } finally {
        conn.release();
    }
});

/**
 * POST /admin/api/ml/request
 * Update ML request settings (maxTopK).
 */
router.post('/api/ml/request', requirePermission('admin_settings'), async (req, res) => {
    const { maxTopK } = req.body || {};
    if (maxTopK === undefined) {
        return res.status(400).json({ error: 'maxTopK is required' });
    }
    const v = parseInt(maxTopK, 10);
    if (!Number.isFinite(v) || v < 1 || v > 100) {
        return res.status(400).json({ error: 'maxTopK must be 1-100' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [current] = await conn.query(
            'SELECT version FROM system_settings WHERE settingKey = ?',
            ['mlRequest']
        );
        if (current.length === 0) {
            await conn.rollback();
            return res.status(500).json({ error: 'mlRequest not initialized' });
        }
        const currentVersion = current[0].version;

        const [existing] = await conn.query('SELECT settingValue FROM system_settings WHERE settingKey = ?', ['mlRequest']);
        let existingValue = existing[0]?.settingValue || '{}';
        if (typeof existingValue === 'string') {
            try { existingValue = JSON.parse(existingValue); } catch (_) { existingValue = {}; }
        }
        const mergedValue = { ...existingValue, maxTopK: v };

        const [result] = await conn.query(
            'UPDATE system_settings SET settingValue = ?, version = version + 1, updatedBy = ?, updatedAt = NOW() WHERE settingKey = ? AND version = ?',
            [JSON.stringify(mergedValue), req.session.accountId, 'mlRequest', currentVersion]
        );

        if (result.affectedRows === 0) {
            await conn.rollback();
            return res.status(409).json({ error: 'Concurrent modification, please retry' });
        }

        await conn.commit();

        const [updated] = await conn.query('SELECT settingValue, version FROM system_settings WHERE settingKey = ?', ['mlRequest']);
        let updatedValue = updated[0].settingValue;
        if (typeof updatedValue === 'string') {
            try { updatedValue = JSON.parse(updatedValue); } catch (_) {}
        }
        res.json({ value: updatedValue, version: updated[0].version });
    } catch (err) {
        await conn.rollback();
        console.error('Update ml request settings error:', err.message);
        res.status(500).json({ error: 'Failed to update ML request settings' });
    } finally {
        conn.release();
    }
});

/**
 * GET /admin/api/role-limits
 * Read-only view of per-role spam quotas.
 */
router.get('/api/role-limits', requirePermission('admin_settings'), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(`
            SELECT r.roleName, rl.limitKey, rl.limitValue
            FROM role_limits rl
            JOIN roles r ON r.roleId = rl.roleId
            ORDER BY r.roleName, rl.limitKey
        `);

        const roleLimits = {};
        for (const row of rows) {
            if (!roleLimits[row.roleName]) roleLimits[row.roleName] = { roleName: row.roleName };
            let value = row.limitValue;
            if (typeof value === 'string') {
                try { value = JSON.parse(value); } catch (_) {}
            }
            roleLimits[row.roleName][row.limitKey] = value;
        }

        res.json({ roleLimits: Object.values(roleLimits) });
    } catch (err) {
        console.error('List role limits error:', err.message);
        res.status(500).json({ error: 'Failed to load role limits' });
    }
});

/**
 * POST /admin/api/role-limits
 * Update per-role spam quotas.
 * Body: { roleLimits: [{ roleName, maxClaimsPerBotanist, maxOpenReportsPerAccount, maxScan, rateLimitWindowMin }] }
 */
router.post('/api/role-limits', requirePermission('admin_settings'), async (req, res) => {
    const { roleLimits } = req.body || {};
    if (!roleLimits || !Array.isArray(roleLimits) || roleLimits.length === 0) {
        return res.status(400).json({ error: 'roleLimits array is required' });
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        for (const limit of roleLimits) {
            const { roleName, maxClaimsPerBotanist, maxOpenReportsPerAccount, maxScan, rateLimitWindowMin } = limit;
            if (!roleName) {
                await conn.rollback();
                return res.status(400).json({ error: 'roleName is required for each limit' });
            }

            // Get roleId from roleName
            const [roleRows] = await conn.query('SELECT roleId FROM roles WHERE roleName = ?', [roleName]);
            if (roleRows.length === 0) {
                await conn.rollback();
                return res.status(400).json({ error: `Unknown role: ${roleName}` });
            }
            const roleId = roleRows[0].roleId;

            // Validate and update each limit
            const updates = [];
            if (maxClaimsPerBotanist !== undefined) {
                const v = parseInt(maxClaimsPerBotanist, 10);
                if (!Number.isFinite(v) || v < 1 || v > 1000) {
                    await conn.rollback();
                    return res.status(400).json({ error: 'maxClaimsPerBotanist must be 1-1000' });
                }
                updates.push({ limitKey: 'maxClaimsPerBotanist', limitValue: v });
            }
            if (maxOpenReportsPerAccount !== undefined) {
                const v = parseInt(maxOpenReportsPerAccount, 10);
                if (!Number.isFinite(v) || v < 1 || v > 1000) {
                    await conn.rollback();
                    return res.status(400).json({ error: 'maxOpenReportsPerAccount must be 1-1000' });
                }
                updates.push({ limitKey: 'maxOpenReportsPerAccount', limitValue: v });
            }
            if (maxScan !== undefined) {
                const v = parseInt(maxScan, 10);
                if (!Number.isFinite(v) || v < 1 || v > 1000) {
                    await conn.rollback();
                    return res.status(400).json({ error: 'maxScan must be 1-1000' });
                }
                updates.push({ limitKey: 'maxScan', limitValue: v });
            }
            if (rateLimitWindowMin !== undefined) {
                const v = parseInt(rateLimitWindowMin, 10);
                if (!Number.isFinite(v) || v < 1 || v > 10080) {
                    await conn.rollback();
                    return res.status(400).json({ error: 'rateLimitWindowMin must be 1-10080' });
                }
                updates.push({ limitKey: 'rateLimitWindowMin', limitValue: v });
            }

            for (const { limitKey, limitValue } of updates) {
                await conn.query(
                    'INSERT INTO role_limits (roleId, limitKey, limitValue) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE limitValue = VALUES(limitValue)',
                    [roleId, limitKey, JSON.stringify(limitValue)]
                );
            }
        }

        await conn.commit();

        // Return updated limits
        const [rows] = await conn.query(`
            SELECT r.roleName, rl.limitKey, rl.limitValue
            FROM role_limits rl
            JOIN roles r ON r.roleId = rl.roleId
            ORDER BY r.roleName, rl.limitKey
        `);

        const updatedLimits = {};
        for (const row of rows) {
            if (!updatedLimits[row.roleName]) updatedLimits[row.roleName] = { roleName: row.roleName };
            let value = row.limitValue;
            if (typeof value === 'string') {
                try { value = JSON.parse(value); } catch (_) {}
            }
            updatedLimits[row.roleName][row.limitKey] = value;
        }

        res.json({ roleLimits: Object.values(updatedLimits) });
    } catch (err) {
        await conn.rollback();
        console.error('Update role limits error:', err.message);
        res.status(500).json({ error: 'Failed to update role limits' });
    } finally {
        conn.release();
    }
});

module.exports = router;
