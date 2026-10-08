const express = require('express');
const path = require('path');
const fs = require('fs');
const { requirePermission } = require('../middleware/authMiddleware');
const { decideRoleRequest, listCertificatesByAccount } = require('../config/mysql.js');
const settings = require('../config/settings');

const router = express.Router();

/**
 * Approves or denies a pending role_permission request from the unified
 * approval_requests queue.
 *
 * The decision body moved into config/mysql.js as `decideRoleRequest` because
 * there are now two callers — this route and the automatic pass — and two copies
 * of a privilege grant is exactly how they drift apart. This handler is now only
 * the HTTP mapping: which verb, which note, which certificate flag, which status
 * code. The response shape is unchanged, because callers of this endpoint already
 * depend on `message`, `accountId` and `newRole`.
 */
async function reviewRoleRequestHandler(req, res, next) {
    const { requestId } = req.params;
    const approve = req.path.endsWith('/approve');
    const { note, deleteCertificate } = req.body;
    const status = approve ? 'approved' : 'denied';

    try {
        const result = await decideRoleRequest(requestId, req.session.accountId, {
            approve,
            note,
            // Only ever meaningful on a denial, and only when the client sent it —
            // an approval must not destroy the certificate the request exists to
            // present as evidence.
            deleteCertificate: !approve && deleteCertificate === true
        });
        if (result.error) return res.status(result.code).json({ error: result.error });
        res.json({
            message: `Role request ${status}`,
            accountId: result.accountId,
            approvalMode: result.approvalMode,
            ...(approve ? { newRole: result.newRole } : {})
        });
    } catch (err) {
        next(err);
    }
}

router.post('/role-requests/:requestId/approve', requirePermission('access_admin'), reviewRoleRequestHandler);
router.post('/role-requests/:requestId/deny', requirePermission('access_admin'), reviewRoleRequestHandler);

// Owner or access_admin only; 404 when there is no row or no file on disk.
router.get('/certificates/:accountId', requirePermission('access_admin'), async (req, res) => {
    const targetAccountId = req.params.accountId;
    const isOwner = req.session.accountId === targetAccountId;

    if (!isOwner) {
        const roles = req.session.roles || [];
        if (!roles.includes('admin') && !roles.includes('superadmin')) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
    }

    try {
        const certs = await listCertificatesByAccount(targetAccountId);
        if (certs.length === 0) {
            return res.status(404).json({ error: 'No certificate found' });
        }

        const latestCert = certs[0];
        // Resolve from the stored relative path, never from client input.
        const fullPath = path.join(settings.certificates.storageDir, latestCert.storedPath);
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: 'Certificate file not found on disk' });
        }

        res.setHeader('Content-Type', latestCert.mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${latestCert.originalFilename}"`);
        res.sendFile(fullPath);
    } catch (err) {
        console.error('Certificate download error:', err.message);
        res.status(500).json({ error: 'Failed to load certificate' });
    }
});

module.exports = router;
