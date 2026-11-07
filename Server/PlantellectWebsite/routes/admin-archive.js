// Admin: the Archive page and everything behind it.
//
//   GET  /admin/archive                                   the page (access_admin)
//   GET  /admin/api/archive/summary                       tiles: archived / deleted totals + the retention days
//   GET  /admin/api/archive/plants?status&search&page     the plants that have something in the archive
//   GET  /admin/api/archive/plants/:plantId/pieces        one plant's pieces (photos, descriptions) with their state
//   POST /admin/api/archive/plants/:plantId/delete        archived plant -> Deleted status      (delete_plant)
//   POST /admin/api/archive/plants/:plantId/undelete      Deleted -> archived again             (delete_plant)
//   POST /admin/api/archive/plants/:plantId/photos/:imageId/delete | undelete
//   POST /admin/api/archive/plants/:plantId/descriptions/:descriptionId/delete | undelete
//   POST /admin/api/plants/:plantId/descriptions/:descriptionId/archive | unarchive   (access_admin)
//   GET / POST /admin/api/archive/settings                the retention days (admin_settings)
//
// Archiving and restoring a whole plant or a photo already exist (routes/admin.js) and are reused by the page.
// "Delete" never removes anything by itself: the item goes to the Deleted status and the nightly job removes
// it once the retention days have passed (config/archive-delete-mysql.js). Every change is written to the log.

const express = require('express');
const path = require('path');
const { requirePermission } = require('../middleware/authMiddleware');
const archiveList = require('../config/archive-list-mysql');
const archiveDelete = require('../config/archive-delete-mysql');
const archiveRetention = require('../config/archive-retention');
const descriptionArchive = require('../config/description-archive-mysql');
const { logAuthEvent } = require('../mongoose-schemas/Authlog');

const router = express.Router();
const view = requirePermission('access_admin');
const archive = requirePermission('access_admin');
const remove = requirePermission('delete_plant');
const configure = requirePermission('admin_settings');

const adminDir = path.join(__dirname, '..', 'administration', 'admin');

router.get('/archive', view, (req, res) => {
    res.sendFile(path.join(adminDir, 'admin-archive.html'));
});

const send = (res, result) => {
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    return res.json(result);
};

const record = (req, metadata) => logAuthEvent({
    accountId: req.session.accountId,
    action: 'archive_changed',
    ip: req.ip,
    userAgent: req.get('User-Agent') || '',
    metadata
});

function guarded(failure, handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (err) {
            console.error(`${failure}:`, err.message);
            res.status(500).json({ error: failure });
        }
    };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

router.get('/api/archive/summary', view, guarded('Failed to load the archive summary', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await archiveList.getArchiveSummary());
}));

router.get('/api/archive/plants', view, guarded('Failed to load the archive', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await archiveList.listArchivePlants({
        status: req.query.status,
        search: req.query.search,
        page: req.query.page,
        pageSize: req.query.pageSize
    }));
}));

router.get('/api/archive/plants/:plantId/pieces', view, guarded('Failed to load the plant\'s archive', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    send(res, await archiveList.getArchivePieces(req.params.plantId));
}));

// ---------------------------------------------------------------------------
// Archive / unarchive one description (photos and plants have theirs in routes/admin.js)
// ---------------------------------------------------------------------------

router.post('/api/plants/:plantId/descriptions/:descriptionId/archive', archive, guarded('Failed to archive the description', async (req, res) => {
    const { plantId, descriptionId } = req.params;
    const result = await descriptionArchive.archiveDescription(plantId, descriptionId, {
        reason: req.body ? req.body.reason : undefined,
        accountId: req.session.accountId
    });
    if (!result.error) {
        await record(req, { action: 'archive', kind: 'description', plantId, descriptionId, archiveReason: result.archiveReason || null });
    }
    send(res, result.error ? result : { ok: true, ...result });
}));

router.post('/api/plants/:plantId/descriptions/:descriptionId/unarchive', archive, guarded('Failed to unarchive the description', async (req, res) => {
    const { plantId, descriptionId } = req.params;
    const result = await descriptionArchive.unarchiveDescription(plantId, descriptionId);
    if (!result.error) await record(req, { action: 'unarchive', kind: 'description', plantId, descriptionId });
    send(res, result);
}));

// ---------------------------------------------------------------------------
// Delete (-> Deleted status) and undo
// ---------------------------------------------------------------------------

const deleteRoutes = [
    // [path after /api/archive/plants/:plantId, kind, action, run, failure]
    ['/delete', 'plant', 'delete', (req) => archiveDelete.deletePlant(req.params.plantId, { accountId: req.session.accountId }), 'Failed to delete the plant'],
    ['/undelete', 'plant', 'undelete', (req) => archiveDelete.undeletePlant(req.params.plantId), 'Failed to undo the deletion'],
    ['/photos/:imageId/delete', 'photo', 'delete', (req) => archiveDelete.deletePhoto(req.params.plantId, req.params.imageId, { accountId: req.session.accountId }), 'Failed to delete the photo'],
    ['/photos/:imageId/undelete', 'photo', 'undelete', (req) => archiveDelete.undeletePhoto(req.params.plantId, req.params.imageId), 'Failed to undo the deletion'],
    ['/descriptions/:descriptionId/delete', 'description', 'delete', (req) => archiveDelete.deleteDescription(req.params.plantId, req.params.descriptionId, { accountId: req.session.accountId }), 'Failed to delete the description'],
    ['/descriptions/:descriptionId/undelete', 'description', 'undelete', (req) => archiveDelete.undeleteDescription(req.params.plantId, req.params.descriptionId), 'Failed to undo the deletion']
];

for (const [suffix, kind, action, run, failure] of deleteRoutes) {
    router.post(`/api/archive/plants/:plantId${suffix}`, remove, guarded(failure, async (req, res) => {
        const result = await run(req);
        if (!result.error) {
            await record(req, {
                action, kind, plantId: req.params.plantId,
                ...(req.params.imageId ? { imageId: req.params.imageId } : {}),
                ...(req.params.descriptionId ? { descriptionId: req.params.descriptionId } : {})
            });
        }
        send(res, result);
    }));
}

// ---------------------------------------------------------------------------
// The retention days (Settings > Archive & Deletion)
// ---------------------------------------------------------------------------

router.get('/api/archive/settings', configure, guarded('Failed to load the archive settings', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...(await archiveRetention.getRetention()), limits: archiveRetention.LIMITS, defaults: archiveRetention.defaults() });
}));

router.post('/api/archive/settings', configure, guarded('Failed to save the archive settings', async (req, res) => {
    const body = req.body || {};
    const saved = await archiveRetention.saveRetention(body, req.session.accountId, body.version);
    if (saved.error) return res.status(saved.code || 400).json({ error: saved.error });
    await record(req, { action: 'settings', retentionDays: saved.value.retentionDays });
    res.json({ ...saved.value, limits: archiveRetention.LIMITS, defaults: archiveRetention.defaults() });
}));

module.exports = router;
