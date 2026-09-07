require('dotenv').config();
const mysql = require('mysql2/promise');

const mysqlPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'plantellectdb',
    charset: 'utf8mb4',
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

module.exports = { mysqlPool, getPermissionsVersion, loadAccountPermissions };
