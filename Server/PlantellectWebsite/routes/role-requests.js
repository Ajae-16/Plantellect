const express = require('express');
const path = require('path');
const fs = require('fs');
const { requirePermission } = require('../middleware/authMiddleware');
const { mysqlPool } = require('../config/mysql.js');
const {
    listCertificatesByAccount,
    deleteCertificate,
    bumpPermissionsVersion
} = require('../config/mysql.js');
const settings = require('../config/settings');

const router = express.Router();

/**
 * Approves or denies a pending role_permission request from the unified
 * approval_requests queue.
 */
async function reviewRoleRequestHandler(req, res, next) {
    const { requestId } = req.params;
    const reviewerId = req.session.accountId;
    const { note, deleteCertificate: shouldDeleteCertificate } = req.body;
    const approve = req.path.endsWith('/approve');
    const status = approve ? 'approved' : 'denied';

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [requestRows] = await conn.query(
            `SELECT accountId, requestedRole FROM approval_requests
             WHERE requestId = ? AND status = 'pending' AND requestType = 'role_permission'
             FOR UPDATE`,
            [requestId]
        );
        if (requestRows.length === 0) {
            await conn.rollback();
            return res.status(409).json({ error: 'Pending role request not found or already resolved' });
        }

        const { accountId, requestedRole } = requestRows[0];

        if (approve) {
            const [roleRows] = await conn.query('SELECT roleId FROM roles WHERE roleName = ?', [requestedRole]);
            if (roleRows.length === 0) {
                await conn.rollback();
                return res.status(400).json({ error: 'Invalid role' });
            }
            await conn.query('UPDATE accounts SET roleId = ? WHERE accountId = ?', [roleRows[0].roleId, accountId]);
            await bumpPermissionsVersion(conn);
        }

        await conn.query(
            `UPDATE approval_requests
             SET status = ?, reviewedBy = ?, reviewedAt = NOW(), note = ?
             WHERE requestId = ?`,
            [status, reviewerId, note || null, requestId]
        );

        if (!approve && shouldDeleteCertificate) {
            const certs = await listCertificatesByAccount(conn, accountId);
            for (const cert of certs) {
                await deleteCertificate(conn, cert.certificateId);
            }
        }

        await conn.commit();

        res.json({
            message: `Role request ${status}`,
            accountId,
            ...(approve ? { newRole: requestedRole } : {})
        });
    } catch (err) {
        await conn.rollback();
        next(err);
    } finally {
        conn.release();
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
