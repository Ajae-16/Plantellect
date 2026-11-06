// Community votes on plant descriptions, signed-in side.
//
//   GET  /api/plants/:plantId/description-votes
//        What the plant page needs to draw the thumbs: per visible description the up count and
//        the viewer's own ballot, the premade down-vote reasons and the note length limit.
//        Open to guests (they see counts, not buttons). Down counts are never sent.
//   POST /api/plants/:plantId/descriptions/:descriptionId/vote
//        Body { value: 'up' | 'down', reasonCode?, reasonNote? }. Casts or switches; idempotent.
//        A down vote needs a premade reasonCode; reasonNote is accepted only with 'other'.
//   DELETE /api/plants/:plantId/descriptions/:descriptionId/vote
//        Retracts the caller's ballot.
//
// Mounted in index.js BEFORE routes/plants.js at the same prefix, like plant-changes.js.

const express = require('express');
const { requireAuth } = require('../middleware/authMiddleware');
const votes = require('../config/description-vote-mysql');

const router = express.Router();

router.get('/:plantId/description-votes', async (req, res) => {
    try {
        const accountId = req.session && req.session.accountId ? req.session.accountId : null;
        // Depends on who is asking, and a stale copy would show a thumb the user just removed.
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Vary', 'Cookie');
        res.json(await votes.getVoteSummary(req.params.plantId, accountId));
    } catch (err) {
        console.error('Description votes read error:', err.message);
        res.status(500).json({ error: 'Failed to load the votes' });
    }
});

router.post('/:plantId/descriptions/:descriptionId/vote', requireAuth, async (req, res) => {
    try {
        const result = await votes.castDescriptionVote(
            req.params.plantId,
            req.params.descriptionId,
            req.session.accountId,
            req.body
        );
        if (result.error) return res.status(result.code || 400).json({ error: result.error });
        res.json(result);
    } catch (err) {
        console.error('Description vote error:', err.message);
        res.status(500).json({ error: 'Failed to record your vote' });
    }
});

router.delete('/:plantId/descriptions/:descriptionId/vote', requireAuth, async (req, res) => {
    try {
        const result = await votes.castDescriptionVote(
            req.params.plantId,
            req.params.descriptionId,
            req.session.accountId,
            null,
            { retract: true }
        );
        if (result.error) return res.status(result.code || 400).json({ error: result.error });
        res.json(result);
    } catch (err) {
        console.error('Description vote retract error:', err.message);
        res.status(500).json({ error: 'Failed to remove your vote' });
    }
});

module.exports = router;
