const express = require('express');
const { getBotanistProfile } = require('../config/mysql.js');

const router = express.Router();

const ADMIN_ROLES = ['admin', 'superadmin'];

/**
 * ASSUMPTION: roles are on the session (req.session.roles). If /api/auth/me gets
 * them another way (for example a lookup by req.session.accountId), change this
 * one function. It fails closed: with no roles found, nobody counts as an admin.
 */
function viewerIsAdmin(req) {
    const roles = (req.session && req.session.roles) || [];
    return Array.isArray(roles) && roles.some((r) => ADMIN_ROLES.includes(r));
}

/**
 * GET /api/botanists/:accountId
 *
 *   botanist profile        -> everyone, guests included
 *   admin / superadmin      -> admins and superadmins only
 *   anything else / absent  -> the SAME 404 with the SAME body, so a restricted
 *                              account is indistinguishable from one that does
 *                              not exist.
 *
 * The reply depends on the session, so it must never sit in a shared cache.
 */
router.get('/:accountId', async (req, res) => {
    try {
        const profile = await getBotanistProfile(req.params.accountId);
        const role = profile && profile.role;
        const allowed = role === 'botanist' || (ADMIN_ROLES.includes(role) && viewerIsAdmin(req));

        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Vary', 'Cookie');
        if (!allowed) return res.status(404).json({ error: 'Profile not found' });
        res.json(profile);
    } catch (err) {
        console.error('Get botanist profile error:', err.message);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

module.exports = router;