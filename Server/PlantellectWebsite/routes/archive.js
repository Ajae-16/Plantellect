// The status of the caller's OWN plants, photos and descriptions once an admin has archived them or put them in
// the Deleted status, so the user who uploaded something can see what happened to it. Any signed-in account.
//
//   GET /api/archive/mine?kind=&state=      everything of mine that is archived or deleted
//                                           kind: plant | photo | description   state: archived | deleted
//   GET /api/archive/mine/:kind/:id         the status of one item of mine
//
// An item: { kind, id, plantId, plantName, state, via, archivedAt, deletedAt, purgeAt, daysLeft }
//   state     'archived' (out of the library, the app and the training set, nothing removed) or
//             'deleted' (waiting; it is removed for good at purgeAt, and an admin can still undo it)
//   via       'self' = that item itself was archived / deleted, 'plant' = its plant was
//   purgeAt   when a deleted item is removed (deletedAt + the retention days in the admin Settings), else null
//   daysLeft  whole days until purgeAt, else null
// The admin's note (archiveReason) is never part of it. Someone else's item answers 404, the same as a missing
// one, so the route never confirms that an item exists. The mobile app reads the same two routes.
//
// plants.js's GET /api/plants/mine also carries `archive` on each photo of a submission (record-mysql.js).

const express = require('express');
const { requireAuth } = require('../middleware/authMiddleware');
const archiveList = require('../config/archive-list-mysql');

const router = express.Router();

router.get('/mine', requireAuth, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(await archiveList.listMyArchive(req.session.accountId, { kind: req.query.kind, state: req.query.state }));
    } catch (err) {
        console.error('List my archive error:', err.message);
        res.status(500).json({ error: 'Failed to load your archived items' });
    }
});

router.get('/mine/:kind/:id', requireAuth, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'private, no-store');
        const item = await archiveList.getMyStatus(req.session.accountId, req.params.kind, req.params.id);
        if (!item) return res.status(404).json({ error: 'Not found' });
        res.json(item);
    } catch (err) {
        console.error('My archive status error:', err.message);
        res.status(500).json({ error: 'Failed to load the status' });
    }
});

module.exports = router;
