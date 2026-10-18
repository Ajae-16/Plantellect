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

module.exports = {
    getSystemSetting
};
