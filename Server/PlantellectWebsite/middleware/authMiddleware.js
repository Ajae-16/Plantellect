const { mysqlPool, getPermissionsVersion, loadAccountPermissions, getSessionGuard } = require('../config/mysql.js');

/**
 * API callers get a JSON 401; browser page loads are redirected to sign in.
 * Without this a fetch() follows the redirect, receives 200 HTML, and
 * response.json() throws a confusing parse error.
 */
function wantsJson(req) {
    return req.path.startsWith('/api') || req.originalUrl.startsWith('/admin/api');
}

function unauthorized(req, res, message) {
    if (wantsJson(req)) {
        return res.status(401).json({ error: message || 'Not authenticated' });
    }
    return res.redirect('/auth.html');
}

function forbidden(res, message) {
    return res.status(403).json({ error: message || 'Insufficient permissions' });
}

/**
 * Brings the cached session back in line with the database.
 *
 * Returns false and clears the session when the account is gone or has been
 * suspended, so deactivation takes effect on the next request rather than at
 * the next login.
 */
async function refreshSession(req) {
    if (!req.session || !req.session.accountId) return false;

    const guard = await getSessionGuard(req.session.accountId);
    if (!guard) {
        await destroySession(req);
        return false;
    }
    if (guard.status !== 'active') {
        await destroySession(req);
        return false;
    }
    if (req.session.permissionsVersion !== guard.permissionsVersion) {
        const perms = await loadAccountPermissions(req.session.accountId);
        req.session.roles = perms.roles;
        req.session.permissions = perms.permissions;
        req.session.permissionsVersion = guard.permissionsVersion;
    }
    return true;
}

function destroySession(req) {
    return new Promise((resolve) => {
        if (!req.session) return resolve();
        req.session.destroy(() => resolve());
    });
}

async function requireAuth(req, res, next) {
    try {
        if (await refreshSession(req)) return next();
        return unauthorized(req, res, 'Not authenticated');
    } catch (err) {
        console.error('requireAuth error:', err.message);
        return res.status(500).json({ error: 'Authentication check failed' });
    }
}

/**
 * Note: this is an OR check. Single-permission calls behave as expected, but
 * do not assume AND semantics if a route ever passes several permissions.
 */
function requirePermission(permissionName) {
    return function (req, res, next) {
        requireAuth(req, res, async () => {
            const permissions = req.session.permissions || [];
            if (permissions.includes(permissionName)) return next();
            return forbidden(res, `Missing permission: ${permissionName}`);
        });
    };
}

function requireRole(roleName) {
    return function (req, res, next) {
        requireAuth(req, res, () => {
            const roles = req.session.roles || [];
            if (roles.includes(roleName)) return next();
            return forbidden(res, `Missing role: ${roleName}`);
        });
    };
}

module.exports = { requireAuth, requirePermission, requireRole, refreshSession, destroySession };
