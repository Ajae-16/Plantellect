// System settings.
// Split out of mysql.js; see mysql.js for the combined export list.

const { mysqlPool } = require('./pool-mysql');

/**
 * Gets a system setting value from system_settings table.
 * Returns the parsed JSON value (object or string) or null if not found.
 * Used by routes/ml.js for mlActiveModel and mlConfidence reads.
 */
async function getSystemSetting(key) {
    const [rows] = await mysqlPool.query(
        'SELECT settingValue FROM system_settings WHERE settingKey = ?',
        [key]
    );
    return rows[0]?.settingValue || null;
}

/**
 * The live plant-photo limits.
 *
 * maxFilesPerRequest is admin-editable (system_settings key 'plantImages') and is
 * re-read on every call, never cached: a cached value is how "I raised the limit
 * and uploads still stop at 20" happens. Size and type stay in settings.js, where
 * they belong to the deployment rather than to an admin form.
 *
 * Falls back to settings.plantImages on a missing key, a malformed value or a DB
 * error, so a settings outage can never make uploads impossible.
 */
async function getPlantImageLimits() {
    const settings = require('./settings');
    const fallback = settings.plantImages.maxFilesPerRequest;
    const ceiling = settings.plantImages.hardMaxFilesPerRequest || 100;
    let maxFiles = fallback;
    try {
        let value = await getSystemSetting('plantImages');
        if (typeof value === 'string') {
            try { value = JSON.parse(value); } catch (err) { value = null; }
        }
        const parsed = value ? parseInt(value.maxFilesPerRequest, 10) : NaN;
        if (Number.isFinite(parsed) && parsed >= 1) maxFiles = Math.min(parsed, ceiling);
    } catch (err) {
        console.error('Could not read plantImages setting:', err.message);
    }
    return {
        maxFilesPerRequest: maxFiles,
        maxSizeBytes: settings.plantImages.maxSizeBytes,
        allowedMimeTypes: settings.plantImages.allowedMimeTypes,
        allowedExtensions: settings.plantImages.allowedExtensions
    };
}

module.exports = {
    getSystemSetting,
    getPlantImageLimits
};
