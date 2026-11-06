// Registration / consent: the consent records written at sign-up.
// Split out of mysql.js; see mysql.js for the combined export list.

const settings = require('./settings');
const { insertRow } = require('./ids.js');
const { mysqlPool } = require('./pool-mysql');

// ---------------------------------------------------------------------------
// Registration / consent
// ---------------------------------------------------------------------------

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
    recordConsent,
    getConsentState
};
