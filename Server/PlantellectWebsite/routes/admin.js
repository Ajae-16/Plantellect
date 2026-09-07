const express = require('express');
const path = require('path');
const { requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/dashboard', requirePermission('access_admin'), (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'admin', 'admin-dashboard.html'));
});

module.exports = router;
