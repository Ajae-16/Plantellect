/**
 * Idempotent schema changes for the recording enhancements. Safe to run twice:
 * the second run prints "already" for every step.
 *
 *   1. plant_images.plantId becomes NULLable — a photo submitted with a brand-new
 *      species has no plant until an admin approves it.
 *   2. approval_requests.requestType gains 'plant_taxonomy'.
 *   3. system_settings gets the 'plantImages' key (the admin photo limit).
 *
 * Wire it into `npm run db:migrate` alongside the existing steps; it only needs
 * the same DB_* environment variables the rest of the project uses.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME
    });
    try {
        const [col] = await conn.query(
            `SELECT IS_NULLABLE FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plant_images' AND COLUMN_NAME = 'plantId'`
        );
        if (col.length && col[0].IS_NULLABLE === 'NO') {
            await conn.query('ALTER TABLE plant_images MODIFY plantId VARCHAR(18) NULL');
            console.log('plant_images.plantId: now nullable');
        } else {
            console.log('plant_images.plantId: already nullable');
        }

        const [enumRows] = await conn.query(
            `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_requests' AND COLUMN_NAME = 'requestType'`
        );
        if (enumRows.length && !String(enumRows[0].COLUMN_TYPE).includes('plant_taxonomy')) {
            await conn.query(
                `ALTER TABLE approval_requests MODIFY requestType
                 ENUM('role_permission','plant_addition','plant_contribution','plant_discovery','plant_taxonomy') NOT NULL`
            );
            console.log("approval_requests.requestType: added 'plant_taxonomy'");
        } else {
            console.log("approval_requests.requestType: already has 'plant_taxonomy'");
        }

        const maxFiles = Math.max(1, parseInt(process.env.MAX_PLANT_IMAGES_PER_REQUEST, 10) || 20);
        const [ins] = await conn.query(
            'INSERT IGNORE INTO system_settings (settingKey, settingValue) VALUES (?, ?)',
            ['plantImages', JSON.stringify({ maxFilesPerRequest: maxFiles })]
        );
        console.log(ins.affectedRows ? `system_settings.plantImages: seeded at ${maxFiles}` : 'system_settings.plantImages: already present');
    } finally {
        await conn.end();
    }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
