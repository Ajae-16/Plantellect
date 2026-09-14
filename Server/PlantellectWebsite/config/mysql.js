require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const settings = require('./settings');

const mysqlPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'plantellectdb',
    charset: 'utf8mb4',
    timezone: settings.system.timezone,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

mysqlPool.getConnection()
    .then((conn) => {
        console.log('Connected to MySQL successfully.');
        conn.release();
    })
    .catch((err) => {
        console.error('MySQL Connection Failed:', err.message);
    });

async function getPermissionsVersion() {
    const [rows] = await mysqlPool.query(
        "SELECT metaValue FROM rbac_meta WHERE metaKey = 'permissions_version'"
    );
    return rows.length > 0 ? parseInt(rows[0].metaValue, 10) : 0;
}

async function loadAccountPermissions(accountId) {
    const [roleRows] = await mysqlPool.query(
        `SELECT r.roleName FROM accounts a
         JOIN roles r ON a.roleId = r.roleId
         WHERE a.accountId = ?`,
        [accountId]
    );
    const roles = roleRows.map((r) => r.roleName);

    const [permRows] = await mysqlPool.query(
        `SELECT DISTINCT p.permissionName FROM permissions p
         JOIN role_permissions rp ON p.permissionId = rp.permissionId
         JOIN roles r ON rp.roleId = r.roleId
         JOIN accounts a ON a.roleId = r.roleId
         WHERE a.accountId = ?`,
        [accountId]
    );
    const permissions = permRows.map((p) => p.permissionName);

    const [userRows] = await mysqlPool.query(
        'SELECT email, username FROM accounts WHERE accountId = ?',
        [accountId]
    );
    const user = userRows[0] || {};

    return { roles, permissions, email: user.email, username: user.username };
}

async function insertCertificate(pool, accountId, fileMeta, settings) {
    const accountDir = path.join(settings.certificates.storageDir, String(accountId));
    if (!fs.existsSync(accountDir)) {
        fs.mkdirSync(accountDir, { recursive: true });
    }
    const ext = path.extname(fileMeta.originalname).toLowerCase();
    const uniqueName = `${crypto.randomUUID()}${ext}`;
    const relativePath = path.join(String(accountId), uniqueName);
    const fullPath = path.join(settings.certificates.storageDir, relativePath);
    
    fs.renameSync(fileMeta.path, fullPath);
    
    const [result] = await pool.query(
        `INSERT INTO certificates (accountId, original_filename, stored_filename, stored_path, mime_type, size)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [accountId, fileMeta.originalname, uniqueName, relativePath, fileMeta.mimetype, fileMeta.size]
    );
    return { certificateId: result.insertId, stored_path: relativePath };
}

async function insertRoleRequest(pool, accountId, requestedRole) {
    const [result] = await pool.query(
        'INSERT INTO role_requests (accountId, requested_role, status) VALUES (?, ?, ?)',
        [accountId, requestedRole, 'pending']
    );
    return { requestId: result.insertId };
}

async function listPendingRoleRequests(pool) {
    const [rows] = await pool.query(
        `SELECT rr.requestId, rr.accountId, rr.requested_role, rr.status, rr.created_at,
                a.email, a.username
         FROM role_requests rr
         JOIN accounts a ON rr.accountId = a.accountId
         WHERE rr.status = 'pending'
         ORDER BY rr.created_at ASC`
    );
    return rows;
}

async function listCertificatesByAccount(pool, accountId) {
    const [rows] = await pool.query(
        'SELECT * FROM certificates WHERE accountId = ? ORDER BY uploaded_at DESC',
        [accountId]
    );
    return rows;
}

async function deleteCertificate(pool, certificateId, storageDir) {
    const [rows] = await pool.query(
        'SELECT stored_path FROM certificates WHERE certificateId = ?',
        [certificateId]
    );
    if (rows.length > 0) {
        const fullPath = path.join(storageDir, rows[0].stored_path);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    }
    await pool.query('DELETE FROM certificates WHERE certificateId = ?', [certificateId]);
}

async function reviewRoleRequest(pool, requestId, reviewerId, status, note) {
    await pool.query(
        'UPDATE role_requests SET status = ?, reviewed_by = ?, reviewed_at = NOW(), note = ? WHERE requestId = ?',
        [status, reviewerId, note || null, requestId]
    );
}

module.exports = { 
    mysqlPool, 
    getPermissionsVersion, 
    loadAccountPermissions,
    insertCertificate,
    insertRoleRequest,
    listPendingRoleRequests,
    listCertificatesByAccount,
    deleteCertificate,
    reviewRoleRequest
};
