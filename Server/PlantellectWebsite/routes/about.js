const express = require('express');
const about = require('../config/about-content');

const router = express.Router();

/**
 * GET /api/about (public, no sign-in): the About text shown on the app's Home page.
 * { title, intro, sections: [{ id, heading, body }] }
 */
router.get('/', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(about);
});

module.exports = router;
