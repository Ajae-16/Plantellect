const express = require('express');
const fs = require('fs');
const { getContributorProfile } = require('../config/mysql.js');
const { resolveStoredPath } = require('../config/profile-mysql');

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
 * Whether this profile may be shown to this viewer.
 *
 *   a contributor (role `user`) -> everyone, guests included, but only while the
 *                                  account is active AND it has at least one
 *                                  plant on the public library. A member who has
 *                                  contributed nothing public has nothing to show,
 *                                  and a profile page would only confirm that the
 *                                  account exists.
 *   admin / superadmin          -> admins and superadmins only
 *   anything else / absent      -> the SAME 404 with the SAME body, so a restricted
 *                                  account is indistinguishable from one that does
 *                                  not exist.
 */
function mayView(profile, req) {
    if (!profile) return false;
    if (ADMIN_ROLES.includes(profile.role)) return viewerIsAdmin(req);
    if (profile.role !== 'user' || profile.status !== 'active') return false;
    const shown = (profile.contributions || []).length + (profile.reported || []).length;
    return shown > 0;
}

/**
 * GET /api/contributors/:accountId
 *
 * The reply depends on the session, so it must never sit in a shared cache.
 */
router.get('/:accountId', async (req, res) => {
    try {
        const profile = await getContributorProfile(req.params.accountId);

        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Vary', 'Cookie');
        if (!mayView(profile, req)) return res.status(404).json({ error: 'Profile not found' });

        // `status` only exists to make the decision above, and `imagePath` is a server path;
        // neither is part of the public shape.
        const { status, imagePath, profileUpdatedAt, ...publicProfile } = profile;
        publicProfile.photoUrl = imagePath
            ? `/api/contributors/${encodeURIComponent(profile.accountId)}/photo?v=${new Date(profileUpdatedAt).getTime() || 0}`
            : null;
        res.json(publicProfile);
    } catch (err) {
        console.error('Get contributor profile error:', err.message);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

/**
 * GET /api/contributors/:accountId/photo
 *
 * The profile photo, under exactly the same visibility rule as the profile itself (mayView), and the
 * same 404 whether there is no photo, no such account, or a profile this viewer may not see.
 */
router.get('/:accountId/photo', async (req, res) => {
    try {
        const profile = await getContributorProfile(req.params.accountId);
        res.setHeader('Cache-Control', 'private, no-cache');
        res.setHeader('Vary', 'Cookie');
        const file = mayView(profile, req) ? resolveStoredPath(profile.imagePath) : null;
        if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Photo not found' });
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(file);
    } catch (err) {
        console.error('Get contributor photo error:', err.message);
        res.status(500).json({ error: 'Failed to load photo' });
    }
});

module.exports = router;
