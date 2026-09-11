const { getPermissionsVersion, loadAccountPermissions } = require('../config/mysql.js');

async function refreshSession(req) {
    if (!req.session || !req.session.accountId) {
        return;
    }
    try {
        const currentVersion = await getPermissionsVersion();
        if (req.session.permissionsVersion !== currentVersion) {
            const perms = await loadAccountPermissions(req.session.accountId);
            req.session.roles = perms.roles;
            req.session.permissions = perms.permissions;
            req.session.permissionsVersion = currentVersion;
        }
    } catch (err) {
        console.error('Failed to refresh session permissions:', err.message);
    }
}

async function requireAuth(req, res, next) {
    if (!req.session || !req.session.accountId) {
        return res.redirect('/auth.html');
    }
    await refreshSession(req);
    next();
}

function requireRole(...allowedRoles) {
    return async (req, res, next) => {
        if (!req.session || !req.session.accountId) {
            return res.redirect('/auth.html');
        }
        await refreshSession(req);
        if (!req.session.roles || !allowedRoles.some((r) => req.session.roles.includes(r))) {
            return res.status(403).json({ error: 'Insufficient role' });
        }
        next();
    };
}

function requirePermission(...requiredPermissions) {
    return async (req, res, next) => {
        if (!req.session || !req.session.accountId) {
            return res.redirect('/auth.html');
        }
        await refreshSession(req);
        if (
            !req.session.permissions ||
            !requiredPermissions.some((p) => req.session.permissions.includes(p))
        ) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}

module.exports = { requireAuth, requireRole, requirePermission };