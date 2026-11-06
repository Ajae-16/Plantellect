// /admin/api/description-feedback/*: the admin side of the description votes.
//
//   GET  /api/description-feedback?filter=attention|hidden|downvoted|upvoted&page=&pageSize=
//   GET  /api/description-feedback/count                       { total, hidden, downvoted, popular }: the dashboard notice + badges
//   GET  /api/description-feedback/:descriptionId/votes        who voted what, and why (admin only)
//   POST /api/description-feedback/:descriptionId/:action      primary | restore | dismiss | remove
//   GET  /api/description-votes/settings                       the two thresholds in force (admin_settings)
//   POST /api/description-votes/settings                       { upvoteAlert?, downvoteHide?, version? }
//
// Viewing needs access_admin. Every decision changes what the public sees, so the four actions
// need manage_plant, like the other plant changes. Each decision is written to the admin log.

const express = require('express');
const { requirePermission } = require('../middleware/authMiddleware');
const votes = require('../config/description-vote-mysql');
const voteSettings = require('../config/description-vote-settings');
const { logAuthEvent } = require('../mongoose-schemas/Authlog');

const router = express.Router();
const view = requirePermission('access_admin');
const change = requirePermission('manage_plant');
const configure = requirePermission('admin_settings');

router.get('/api/description-feedback/count', view, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await votes.countFeedback());
    } catch (err) {
        console.error('Description feedback count error:', err.message);
        res.status(500).json({ error: 'Failed to count description feedback' });
    }
});

router.get('/api/description-feedback', view, async (req, res) => {
    try {
        const filter = votes.FEEDBACK_FILTERS.includes(req.query.filter) ? req.query.filter : 'attention';
        res.setHeader('Cache-Control', 'no-store');
        res.json(await votes.listFeedback({ filter, page: req.query.page, pageSize: req.query.pageSize }));
    } catch (err) {
        console.error('Description feedback list error:', err.message);
        res.status(500).json({ error: 'Failed to load description feedback' });
    }
});

router.get('/api/description-feedback/:descriptionId/votes', view, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await votes.listVoters(req.params.descriptionId));
    } catch (err) {
        console.error('Description voters error:', err.message);
        res.status(500).json({ error: 'Failed to load the votes' });
    }
});

router.post('/api/description-feedback/:descriptionId/:action', change, async (req, res) => {
    try {
        const result = await votes.applyFeedbackAction(
            req.params.descriptionId,
            req.session.accountId,
            req.params.action
        );
        if (result.error) return res.status(result.code || 400).json({ error: result.error });
        await logAuthEvent({
            accountId: req.session.accountId,
            action: 'description_feedback_changed',
            ip: req.ip,
            userAgent: req.get('User-Agent') || '',
            metadata: { action: result.action, plantId: result.plantId, descriptionId: result.descriptionId }
        });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('Description feedback action error:', err.message);
        res.status(500).json({ error: 'Failed to apply that decision' });
    }
});

router.get('/api/description-votes/settings', configure, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ...(await voteSettings.getVoteSettings()), limits: voteSettings.LIMITS, defaults: voteSettings.defaults() });
    } catch (err) {
        console.error('Description vote settings read error:', err.message);
        res.status(500).json({ error: 'Failed to load the vote settings' });
    }
});

router.post('/api/description-votes/settings', configure, async (req, res) => {
    try {
        const body = req.body || {};
        const saved = await voteSettings.saveVoteSettings(body, req.session.accountId, body.version);
        if (saved.error) return res.status(saved.code || 400).json({ error: saved.error });
        // A LOWER hide threshold takes effect now, not at the next vote on each description.
        const hiddenNow = await votes.applyDownvoteThreshold();
        await logAuthEvent({
            accountId: req.session.accountId,
            action: 'description_feedback_changed',
            ip: req.ip,
            userAgent: req.get('User-Agent') || '',
            metadata: { action: 'settings', upvoteAlert: saved.value.upvoteAlert, downvoteHide: saved.value.downvoteHide, hiddenNow }
        });
        res.json({ ...saved.value, hiddenNow, limits: voteSettings.LIMITS, defaults: voteSettings.defaults() });
    } catch (err) {
        console.error('Description vote settings save error:', err.message);
        res.status(500).json({ error: 'Failed to save the vote settings' });
    }
});

module.exports = router;
