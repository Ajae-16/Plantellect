/**
 * Idempotent schema change: remembers who last edited a description and when.
 *   plant_description.editedAt  DATETIME NULL  (NULL = never edited)
 *   plant_description.editedBy  accountId of the person whose change request was applied last
 * Safe to run twice. Same DB_* environment variables as the other migrations.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function addColumn(conn, column, definition) {
    const [rows] = await conn.query(
        `SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plant_description' AND COLUMN_NAME = ?`,
        [column]
    );
    if (rows.length) return console.log(`plant_description.${column}: already there`);
    await conn.query(`ALTER TABLE plant_description ADD COLUMN \`${column}\` ${definition}`);
    console.log(`plant_description.${column}: added`);
}

async function main() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME
    });
    try {
        const [acc] = await conn.query(
            `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = 'accountId'`
        );
        const idType = acc.length ? acc[0].COLUMN_TYPE : 'VARCHAR(18)';   // match accounts.accountId exactly
        await addColumn(conn, 'editedAt', 'DATETIME NULL');
        await addColumn(conn, 'editedBy', `${idType} NULL`);
    } finally {
        await conn.end();
    }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
