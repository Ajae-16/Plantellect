// Registration / consent: certificates, role requests and consent records written at sign-up.
// Split out of mysql.js; see mysql.js for the combined export list.

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const settings = require('./settings');
const { insertRow } = require('./ids.js');
const { mysqlPool } = require('./pool-mysql');

// ---------------------------------------------------------------------------
// Registration / consent
// ---------------------------------------------------------------------------

async function insertCertificate(conn, accountId, fileMeta) {
    const accountDir = path.join(settings.certificates.storageDir, String(accountId));
    if (!fs.existsSync(accountDir)) {
        fs.mkdirSync(accountDir, { recursive: true });
    }
    const ext = path.extname(fileMeta.originalname).toLowerCase();
    const storedFilename = `${crypto.randomUUID()}${ext}`;
    const relativePath = path.join(String(accountId), storedFilename);
    const fullPath = path.join(settings.certificates.storageDir, relativePath);

    fs.renameSync(fileMeta.path, fullPath);

    const certificateId = await insertRow(
        conn,
        'certificates',
        ['accountId', 'originalFilename', 'storedFilename', 'storedPath', 'mimeType', 'size'],
        [accountId, fileMeta.originalname, storedFilename, relativePath, fileMeta.mimetype, fileMeta.size]
    );
    return { certificateId, storedPath: relativePath };
}

async function insertRoleRequest(conn, accountId, requestedRole) {
    return insertRow(
        conn,
        'approval_requests',
        ['accountId', 'requestType', 'requestedRole', 'status'],
        [accountId, 'role_permission', requestedRole, 'pending']
    );
}

async function recordConsent(conn, accountId, consentTypes, version) {
    const written = [];
    for (const consentType of consentTypes) {
        written.push(await insertRow(
            conn,
            'terms_acceptance',
            ['accountId', 'consentType', 'termsVersion'],
            [accountId, consentType, version]
        ));
    }
    return written;
}

/** Newest recorded consent per type, and whether it is still current. */
async function getConsentState(accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT consentType, termsVersion, acceptedAt FROM (
             SELECT consentType, termsVersion, acceptedAt,
                    ROW_NUMBER() OVER (
                        PARTITION BY consentType
                        ORDER BY acceptedAt DESC, acceptanceId DESC
                    ) AS rn
             FROM terms_acceptance
             WHERE accountId = ?
         ) t WHERE rn = 1`,
        [accountId]
    );
    const state = {};
    for (const row of rows) {
        state[row.consentType] = {
            termsVersion: row.termsVersion,
            acceptedAt: row.acceptedAt,
            current: row.termsVersion === settings.terms.version
        };
    }
    return state;
}

module.exports = {
    insertCertificate,
    insertRoleRequest,
    recordConsent,
    getConsentState
};
