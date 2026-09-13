const express = require('express');
const path = require('path');
const fs = require('fs');
const { requirePermission } = require('../middleware/authMiddleware');
const { mysqlPool } = require('../config/mysql.js');
const { listPendingRoleRequests, reviewRoleRequest, loadAccountPermissions, deleteCertificate, listCertificatesByAccount } = require('../config/mysql.js');
const settings = require('../config/settings');

const router = express.Router();

router.get('/role-requests', requirePermission('access_admin'), async (req, res) => {
    try {
        const requests = await listPendingRoleRequests(mysqlPool);
        res.json({ requests });
    } catch (err) {
        console.error('List pending role requests error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.post('/role-requests/:requestId/approve', requirePermission('access_admin'), async (req, res) => {
    const { requestId } = req.params;
    const reviewerId = req.session.accountId;
    const { note } = req.body;

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [requestRows] = await conn.query(
            'SELECT accountId, requested_role FROM role_requests WHERE requestId = ? AND status = ?',
            [requestId, 'pending']
        );
        if (requestRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'Pending role request not found' });
        }

        const { accountId, requested_role } = requestRows[0];

        const [roleRows] = await conn.query('SELECT roleId FROM roles WHERE roleName = ?', [requested_role]);
        if (roleRows.length === 0) {
            await conn.rollback();
            return res.status(400).json({ error: 'Invalid role' });
        }
        const newRoleId = roleRows[0].roleId;

        await conn.query('UPDATE accounts SET roleId = ? WHERE accountId = ?', [newRoleId, accountId]);

        await conn.query(
            'UPDATE role_requests SET status = ?, reviewed_by = ?, reviewed_at = NOW(), note = ? WHERE requestId = ?',
            ['approved', reviewerId, note || null, requestId]
        );

        await conn.query("UPDATE rbac_meta SET metaValue = metaValue + 1 WHERE metaKey = 'permissions_version'");

        await conn.commit();

        res.json({ message: 'Role request approved', accountId, newRole: requested_role });
    } catch (err) {
        await conn.rollback();
        console.error('Approve role request error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

router.post('/role-requests/:requestId/deny', requirePermission('access_admin'), async (req, res) => {
    const { requestId } = req.params;
    const reviewerId = req.session.accountId;
    const { note, deleteCertificate: shouldDeleteCertificate } = req.body;

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [requestRows] = await conn.query(
            'SELECT accountId FROM role_requests WHERE requestId = ? AND status = ?',
            [requestId, 'pending']
        );
        if (requestRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'Pending role request not found' });
        }

        const { accountId } = requestRows[0];

        await conn.query(
            'UPDATE role_requests SET status = ?, reviewed_by = ?, reviewed_at = NOW(), note = ? WHERE requestId = ?',
            ['denied', reviewerId, note || null, requestId]
        );

        if (shouldDeleteCertificate) {
            const certs = await listCertificatesByAccount(conn, accountId);
            for (const cert of certs) {
                const fullPath = path.join(settings.certificates.storageDir, cert.stored_path);
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                }
            }
            await conn.query('DELETE FROM certificates WHERE accountId = ?', [accountId]);
        }

        await conn.commit();

        res.json({ message: 'Role request denied', accountId });
    } catch (err) {
        await conn.rollback();
        console.error('Deny role request error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

router.get('/certificates/:accountId', async (req, res) => {
    if (!req.session || !req.session.accountId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const targetAccountId = parseInt(req.params.accountId, 10);
    const isOwner = req.session.accountId === targetAccountId;
    const isAdmin = (req.session.roles || []).includes('superadmin') || (req.session.roles || []).includes('admin');

    if (!isOwner && !isAdmin) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }

    try {
        const certs = await listCertificatesByAccount(mysqlPool, targetAccountId);
        if (certs.length === 0) {
            return res.status(404).json({ error: 'No certificate found' });
        }

        const latestCert = certs[0];
        const fullPath = path.join(settings.certificates.storageDir, latestCert.stored_path);
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: 'Certificate file not found on disk' });
        }

        res.setHeader('Content-Type', latestCert.mime_type);
        res.setHeader('Content-Disposition', `inline; filename="${latestCert.original_filename}"`);
        res.sendFile(fullPath);
    } catch (err) {
        console.error('Certificate download error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;