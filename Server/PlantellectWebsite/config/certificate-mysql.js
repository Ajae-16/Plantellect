// Certificates.
// Split out of mysql.js; see mysql.js for the combined export list.

const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const { mysqlPool } = require('./pool-mysql');

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

async function listCertificatesByAccount(accountId) {
    const [rows] = await mysqlPool.query(
        'SELECT * FROM certificates WHERE accountId = ? ORDER BY uploadedAt DESC',
        [accountId]
    );
    return rows;
}

async function deleteCertificate(conn, certificateId) {
    const [rows] = await conn.query('SELECT storedPath FROM certificates WHERE certificateId = ?', [certificateId]);
    if (rows.length > 0) {
        const fullPath = path.join(settings.certificates.storageDir, rows[0].storedPath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
    await conn.query('DELETE FROM certificates WHERE certificateId = ?', [certificateId]);
}

module.exports = {
    listCertificatesByAccount,
    deleteCertificate
};
