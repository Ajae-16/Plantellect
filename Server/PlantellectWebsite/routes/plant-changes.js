const express = require('express');
const { requirePermission } = require('../middleware/authMiddleware');
const pm = require('../config/plant-manage-mysql');

const router = express.Router();

// Mounted in index.js BEFORE the existing plants router, at the same prefix:
//   app.use('/api/plants', require('./routes/plant-changes'));
//   app.use('/api/plants', require('./routes/plants'));
// Both paths have two segments, so they cannot collide with /mine, /lookup,
// /limits or /types.

/**
 * The plant's current editable values for the "Request change" form: the shared
 * plant info, plus ONLY the descriptions the signed-in botanist wrote.
 */
router.get('/:plantId/editable', requirePermission('record_plant'), async (req, res) => {
    try {
        const plant = await pm.getPlantEditable(req.params.plantId, req.session.accountId);
        if (!plant) return res.status(404).json({ error: 'Plant not found' });
        // The form is built from these values and the request is compared against
        // them at approval, so a cached copy would file stale changes.
        res.setHeader('Cache-Control', 'no-store');
        res.json(plant);
    } catch (err) {
        console.error('Plant editable error:', err.message);
        res.status(500).json({ error: 'Failed to load the plant' });
    }
});

/**
 * File a change request. Nothing changes until an admin approves it.
 * Body: { base?: {...}, description?: {...} }, each with its own `reason`. Each
 * scope that is present becomes its own request, decided on its own.
 */
router.post('/:plantId/changes', requirePermission('record_plant'), async (req, res) => {
    try {
        const result = await pm.createPlantChangeRequest(req.session.accountId, req.params.plantId, req.body || {});
        if (result.error) return res.status(result.code || 400).json({ error: result.error });
        // Never auto-approved: change requests have no approval switch, so an admin decides.
        res.status(201).json({
            requestId: result.requestId,
            requests: result.requests,
            message: result.requests.length > 1
                ? 'Two change requests submitted for review'
                : 'Change request submitted for review'
        });
    } catch (err) {
        console.error('Create plant change request error:', err.message);
        res.status(500).json({ error: 'Failed to send the change request' });
    }
});

module.exports = router;
