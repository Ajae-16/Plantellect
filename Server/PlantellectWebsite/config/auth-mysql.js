// Session / auth support: permissions version, session guard, role and permission loading.
// Split out of mysql.js; see mysql.js for the combined export list.

const { mysqlPool } = require('./pool-mysql');

// ---------------------------------------------------------------------------
// Session / auth support
// ---------------------------------------------------------------------------

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

/** Status plus permissions version, read together on every authenticated request. */
async function getSessionGuard(accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT a.status, m.metaValue
         FROM accounts a
         LEFT JOIN rbac_meta m ON m.metaKey = 'permissions_version'
         WHERE a.accountId = ?`,
        [accountId]
    );
    if (rows.length === 0) return null;
    return {
        status: rows[0].status,
        permissionsVersion: rows[0].metaValue ? parseInt(rows[0].metaValue, 10) : 0
    };
}

async function bumpPermissionsVersion(conn) {
    const target = conn || mysqlPool;
    await target.query(
        "UPDATE rbac_meta SET metaValue = metaValue + 1 WHERE metaKey = 'permissions_version'"
    );
}

/** A role is privileged when it holds access_admin; derived, not hardcoded. */
async function getPrivilegedRoleIds(conn) {
    const target = conn || mysqlPool;
    const [rows] = await target.query(
        `SELECT DISTINCT r.roleId
         FROM role_permissions rp
         JOIN permissions p ON rp.permissionId = p.permissionId
         JOIN roles r ON rp.roleId = r.roleId
         WHERE p.permissionName = 'access_admin'`
    );
    return new Set(rows.map((r) => r.roleId));
}

async function countActiveSuperadmins(conn, excludeAccountId) {
    const target = conn || mysqlPool;
    const [rows] = await target.query(
        `SELECT COUNT(*) AS n FROM accounts a
         JOIN roles r ON a.roleId = r.roleId
         WHERE r.roleName = 'superadmin' AND a.status = 'active' AND a.accountId <> ?`,
        [excludeAccountId || '']
    );
    return rows[0].n;
}

module.exports = {
    getPermissionsVersion,
    loadAccountPermissions,
    getSessionGuard,
    bumpPermissionsVersion,
    getPrivilegedRoleIds,
    countActiveSuperadmins
};
