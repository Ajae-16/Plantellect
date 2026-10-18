// Admin: users.
// Split out of mysql.js; see mysql.js for the combined export list.

const { mysqlPool } = require('./pool-mysql');
const { parsePaging, escapeLike } = require('./shared-mysql');
const { getPrivilegedRoleIds, countActiveSuperadmins, bumpPermissionsVersion } = require('./auth-mysql');

// ---------------------------------------------------------------------------
// Admin: users
// ---------------------------------------------------------------------------

/**
 * Paginated, searchable, filterable user list. `counts` is a separate aggregate
 * over every account, because a page of rows cannot produce card totals.
 */
async function listUsers({ search, role, status, page, pageSize }) {
    const paging = parsePaging({ page, pageSize });
    const where = [];
    const params = [];

    if (search) {
        where.push("(a.username LIKE ? ESCAPE '\\\\' OR a.email LIKE ? ESCAPE '\\\\' OR CONCAT(pr.firstName,' ',pr.lastName) LIKE ? ESCAPE '\\\\')");
        const like = `%${escapeLike(search)}%`;
        params.push(like, like, like);
    }
    if (role) {
        // The Administrators card covers every privileged role, so a database
        // holding only the superadmin still shows an administrator there.
        // Derived from access_admin rather than hardcoded.
        if (role === 'admin') {
            where.push(`r.roleId IN (
                SELECT rp.roleId FROM role_permissions rp
                JOIN permissions p ON rp.permissionId = p.permissionId
                WHERE p.permissionName = 'access_admin'
            )`);
        } else {
            where.push('r.roleName = ?');
            params.push(role);
        }
    }
    if (status) {
        where.push('a.status = ?');
        params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await mysqlPool.query(
        `SELECT a.accountId AS id,
                COALESCE(CONCAT(pr.firstName, ' ', pr.lastName), '') AS fullName,
                a.username,
                a.email,
                r.roleName AS role,
                a.status,
                a.createdAt,
                a.lastLoginAt
         FROM accounts a
         JOIN roles r ON a.roleId = r.roleId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         ${whereSql}
         ORDER BY a.createdAt DESC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );

    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total
         FROM accounts a
         JOIN roles r ON a.roleId = r.roleId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         ${whereSql}`,
        params
    );

    const [cardRows] = await mysqlPool.query(
        `SELECT r.roleId, r.roleName, COUNT(*) AS n
         FROM accounts a JOIN roles r ON a.roleId = r.roleId
         GROUP BY r.roleId, r.roleName`
    );
    const privilegedIds = await getPrivilegedRoleIds();
    const counts = { admin: 0, botanist: 0, user: 0, active: 0 };
    for (const row of cardRows) {
        if (privilegedIds.has(row.roleId)) {
            // Matches the Administrators card filter, so the card and the table agree.
            counts.admin += row.n;
        } else if (row.roleName in counts) {
            counts[row.roleName] = row.n;
        }
    }
    const [activeRows] = await mysqlPool.query(
        "SELECT COUNT(*) AS n FROM accounts WHERE status = 'active'"
    );
    counts.active = activeRows[0].n;

    return {
        users: rows.map((r) => ({
            id: r.id,
            name: r.fullName.trim() || r.username,
            username: r.username,
            email: r.email,
            role: r.role,
            status: r.status,
            createdAt: r.createdAt,
            lastLoginAt: r.lastLoginAt
        })),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize,
        counts
    };
}

/**
 * Suspends or reactivates an account. Rejects a change that would leave no
 * active superadmin, and rejects the caller deactivating themselves.
 *
 * The system actor cannot be reactivated. `inactive` is the whole reason it can
 * never authenticate, and the Users page offers a Suspend/Reactivate control on
 * every row — so without this guard one click would turn a machine identity with a
 * throwaway password hash into a loginable account. Suspending it is allowed,
 * because it is already suspended and "make it more capable" is not a direction
 * this project goes in.
 */
async function setAccountStatus(accountId, status, actorAccountId) {
    if (actorAccountId && actorAccountId === accountId) {
        return { error: 'You cannot change your own account status', code: 409 };
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT a.status, r.roleName
             FROM accounts a JOIN roles r ON r.roleId = a.roleId
             WHERE a.accountId = ? FOR UPDATE`,
            [accountId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Account not found', code: 404 };
        }

        if (rows[0].roleName === 'system' && status === 'active') {
            await conn.rollback();
            return {
                error: 'The system account is a machine actor and cannot be activated. ' +
                    'Automatic approvals are authorised by the admin who enabled the mode.',
                code: 409
            };
        }

        if (status === 'inactive' && rows[0].roleName === 'superadmin') {
            const remaining = await countActiveSuperadmins(conn, accountId);
            if (remaining === 0) {
                await conn.rollback();
                return {
                    error: 'The last active superadmin cannot be suspended. Promote another superadmin first.',
                    code: 409
                };
            }
        }

        await conn.query('UPDATE accounts SET status = ? WHERE accountId = ?', [status, accountId]);
        await conn.commit();
        return { accountId, status };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Changes an account's role. Assigning or stripping a privileged role requires
 * admin_promote; otherwise change_role covers user <-> botanist only.
 *
 * The `system` role is outside that range in both directions and is refused here
 * rather than hidden in the UI. The dropdown already omits it, but the endpoint is
 * the gate: assigning `system` would silently strip a real person of every
 * permission, and moving the machine actor onto a human would put a loginable
 * account holding the reviewer value that automatic approvals are written as.
 */
async function changeAccountRole(accountId, newRoleName, actorPermissions, actorAccountId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [targetRows] = await conn.query(
            `SELECT a.roleId, r.roleName
             FROM accounts a JOIN roles r ON r.roleId = a.roleId
             WHERE a.accountId = ? FOR UPDATE`,
            [accountId]
        );
        if (targetRows.length === 0) {
            await conn.rollback();
            return { error: 'Account not found', code: 404 };
        }

        if (newRoleName === 'system' || targetRows[0].roleName === 'system') {
            await conn.rollback();
            return {
                error: 'The system role is a machine actor and is not assignable',
                code: 400
            };
        }


        const [newRoleRows] = await conn.query(
            'SELECT roleId, roleName FROM roles WHERE roleName = ?',
            [newRoleName]
        );
        if (newRoleRows.length === 0) {
            await conn.rollback();
            return { error: 'Unknown role', code: 400 };
        }

        const privileged = await getPrivilegedRoleIds(conn);
        const currentIsPrivileged = privileged.has(targetRows[0].roleId);
        const newIsPrivileged = privileged.has(newRoleRows[0].roleId);
        const actorCanPromote = (actorPermissions || []).includes('admin_promote');

        if (currentIsPrivileged || newIsPrivileged) {
            if (!actorCanPromote) {
                await conn.rollback();
                return { error: 'admin_promote permission is required for this role change', code: 403 };
            }
        } else if (!(actorPermissions || []).includes('change_role')) {
            await conn.rollback();
            return { error: 'change_role permission is required', code: 403 };
        }

        if (targetRows[0].roleName === 'superadmin' && newRoleName !== 'superadmin') {
            const remaining = await countActiveSuperadmins(conn, accountId);
            if (remaining === 0) {
                await conn.rollback();
                return {
                    error: 'The last active superadmin cannot be demoted. Promote another superadmin first.',
                    code: 409
                };
            }
        }
        if (actorAccountId && actorAccountId === accountId && newRoleName !== targetRows[0].roleName) {
            await conn.rollback();
            return { error: 'You cannot change your own role', code: 409 };
        }

        await conn.query('UPDATE accounts SET roleId = ? WHERE accountId = ?', [
            newRoleRows[0].roleId,
            accountId
        ]);
        await bumpPermissionsVersion(conn);
        await conn.commit();
        return { accountId, role: newRoleName };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = {
    listUsers,
    setAccountStatus,
    changeAccountRole
};
