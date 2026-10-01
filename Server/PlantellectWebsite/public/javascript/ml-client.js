/**
 * Plantellect ML Client
 * Frontend helper for plant identification predictions via the ML inference service.
 * Uses the Express proxy at /api/ml/predict which forwards to the FastAPI service.
 */

/**
 * Predict plant species from an image file.
 * @param {File} imageFile - Image file object (from file input or canvas capture)
 * @param {number} topK - Number of top predictions to return (default: 5)
 * @returns {Promise<Object>} Prediction results with predictions array, inference_ms, model_version
 */
async function predictPlant(imageFile, topK = 5) {
    const formData = new FormData();
    formData.append('image', imageFile);
    formData.append('top_k', topK);

    const response = await fetch('/api/ml/predict', {
        method: 'POST',
        body: formData,
        credentials: 'include'
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Prediction failed' }));
        throw new Error(error.error || 'Prediction failed');
    }

    return response.json();
}

/**
 * Get model metadata from the ML service.
 * @returns {Promise<Object>} Model info with model_version, input_shape, num_classes, classes
 */
async function getModelInfo() {
    const response = await fetch('/api/ml/model/info', {
        method: 'GET',
        credentials: 'include'
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to fetch model info' }));
        throw new Error(error.error || 'Failed to fetch model info');
    }

    return response.json();
}

/**
 * Check if the ML service is healthy.
 * @returns {Promise<boolean>} True if healthy
 */
async function checkMLHealth() {
    try {
        const response = await fetch('/api/ml/health', {
            method: 'GET',
            credentials: 'include'
        });
        return response.ok;
    } catch {
        return false;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { predictPlant, getModelInfo, checkMLHealth };
}