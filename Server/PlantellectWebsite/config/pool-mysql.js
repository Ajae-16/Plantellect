// MySQL connection pool. Loaded first so dotenv is configured before the pool is created.
// Split out of mysql.js; see mysql.js for the combined export list.

require('dotenv').config();
const mysql = require('mysql2/promise');

const settings = require('./settings');

const mysqlPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
    timezone: settings.system.timezone,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

mysqlPool.getConnection()
    .then((conn) => {
        console.log('Connected to MySQL successfully.');
        conn.release();
    })
    .catch((err) => {
        console.error('MySQL Connection Failed:', err.message);
    });

module.exports = {
    mysqlPool
};
