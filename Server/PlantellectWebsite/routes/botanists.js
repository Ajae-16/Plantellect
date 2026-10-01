const express = require('express');
const { getBotanistProfile } = require('../config/mysql.js');

const router = express.Router();

router.get('/:accountId', async (req, res) => {
    try {
        const profile = await getBotanistProfile(req.params.accountId);
        if (!profile) return res.status(404).json({ error: 'Botanist not found' });
        res.json(profile);
    } catch (err) {
        console.error('Get botanist profile error:', err.message);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

module.exports = router;
