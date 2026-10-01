const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/authMiddleware');
const { resolveScientificNames } = require('../config/mysql.js');
const settings = require('../config/settings');
const router = express.Router();

const ML_SERVICE_URL = settings.ml.serviceUrl;

// Multer memory storage for proxying to FastAPI
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Attaches plantId and imageUrl to each prediction by matching its
 * scientific_name against the plants table. Names with no matching plant are
 * left untouched so a prediction is never dropped just because the library
 * does not know the species yet.
 */
async function attachPlantLinks(data) {
    if (!data || !Array.isArray(data.predictions) || data.predictions.length === 0) {
        return data;
    }
    try {
        const names = data.predictions
            .map((p) => p.scientific_name)
            .filter((n) => typeof n === 'string' && n.length > 0);
        const matches = await resolveScientificNames(names);
        for (const prediction of data.predictions) {
            const match = matches.get(prediction.scientific_name);
            if (match) {
                prediction.plantId = match.plantId;
                if (match.heroImageId) {
                    prediction.imageUrl = `/api/plants/${match.plantId}/images/${match.heroImageId}`;
                }
            }
        }
    } catch (err) {
        // A lookup failure must not break the prediction itself.
        console.error('Plant link lookup failed:', err.message);
    }
    return data;
}

// Proxy prediction to FastAPI
router.post('/predict', requireAuth, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        const formData = new FormData();
        formData.append('image', new Blob([req.file.buffer]), req.file.originalname);
        formData.append('top_k', String(req.body.top_k || 5));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), settings.ml.timeoutMs);

        try {
            const response = await fetch(`${ML_SERVICE_URL}/predict`, {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });

            const data = await attachPlantLinks(await response.json());
            res.status(response.status).json(data);
        } finally {
            clearTimeout(timeoutId);
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'ML service timeout' });
        }
        console.error('ML proxy error:', err);
        res.status(502).json({ error: 'ML service unavailable' });
    }
});

router.get('/model/info', requireAuth, async (req, res) => {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), settings.ml.timeoutMs);

        try {
            const response = await fetch(`${ML_SERVICE_URL}/model/info`, { signal: controller.signal });
            const data = await response.json();
            res.status(response.status).json(data);
        } finally {
            clearTimeout(timeoutId);
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'ML service timeout' });
        }
        res.status(502).json({ error: 'ML service unavailable' });
    }
});

module.exports = router;
