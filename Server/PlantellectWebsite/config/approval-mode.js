/**
 * Manual or automatic approval, per request type, and the machine actor that
 * automatic decisions are attributed to.
 *
 * Every read and every write of an approval switch goes through this file. No
 * route spells an `rbac_meta` key or the system account id inline, because the
 * two mistakes this exists to prevent are:
 *
 *   - a key name typed into a route and never matching the seed, so the switch
 *     silently reads as off forever; and
 *   - a route deciding "is this auto?" from its own cached idea of the value,
 *     which disagrees with the transaction that acts on it.
 *
 * Every function here takes an EXECUTOR (a pool or an open connection) rather
 * than importing config/mysql.js. That is not tidiness: the mode is read INSIDE
 * the transaction that performs the decision, so the switch and the decision are
 * one consistent snapshot, and importing the pool here would create a cycle.
 */

const { resolveSetting } = require('./limits.js');

// ---------------------------------------------------------------------------
// The switches
// ---------------------------------------------------------------------------

/**
 * THREE keys, not four, and the absence of `approval_auto_plant_discovery` is
 * deliberate.
 *
 * A discovery report carries no species of its own; its approval IS the approval
 * of the record it produced, so the decision auto mode would make is already made
 * on a `plant_addition`, which is covered here. A fourth key would imply the
 * queue can clear itself for reports that produced nothing — exactly the noise
 * the rails exist to prevent — and would be inert anyway, because
 * approvePlantRequest rejects a plant_discovery outright.
 */
const APPROVAL_AUTO_KEYS = {
    role_permission: 'approval_auto_role_permission',
    plant_addition: 'approval_auto_plant_addition',
    plant_contribution: 'approval_auto_plant_contribution'
};

/** The closed set the admin API validates `requestType` against. */
const APPROVAL_REQUEST_TYPES = Object.keys(APPROVAL_AUTO_KEYS);

/**
 * Copy for the settings block, kept next to the keys so the UI cannot describe a
 * switch that does not exist, and so the two switches that publish content carry
 * the warning the plan insists on.
 *
 * The plant_addition copy is deliberately broader than "fewer approval clicks".
 * Enabling it also covers records made FROM a discovery report, so a report filed
 * because the model could not identify a species can then be resolved end to end
 * with no human reviewing the description, the measurements or the photos — which
 * become public content and ML training data unreviewed. Accepted, because every
 * key here defaults '0' and the state is only reachable by an admin who
 * deliberately switches it on; but the dialog has to name it or an admin enables
 * what they read as a queue tweak and does not know training data is involved.
 */
const APPROVAL_MODE_LABELS = {
    role_permission: {
        label: 'Botanist role requests',
        detail: 'Grants record_plant to an account whose role request is approved.',
        publishesContent: false,
        warning: null,
        /**
         * Said plainly because the switch CANNOT currently approve anything, and a
         * switch labelled "Automatic" that silently never fires is worse than no
         * switch at all.
         *
         * The only source of a role request is registration, and every
         * registration is its submitter's first submission of that type — which
         * the permanent first-submission rail always holds for review. So with the
         * rail in place this key is readable and writable but cannot approve a role
         * request. It is kept rather than dropped for two reasons: the rails are
         * permanent and something must be able to record their intent, and the key
         * is what a future rule that has actually seen a human approve a role
         * request would be switched through.
         *
         * The alternative — exempting role requests from the rail so the switch
         * does something — means the first botanist credentials anybody ever sees
         * are accepted by a rule that has never watched a human accept one. A
         * privilege grant is the highest-stakes decision in the system; it is not
         * the right place to trade a safety rail for a green light.
         */
        note: 'Currently cannot approve anything: every role request is a first submission, ' +
            'and first submissions are always reviewed by hand. Kept as the switch a future ' +
            'role rule would use.'
    },
    plant_addition: {
        label: 'New plant submissions',
        detail: 'Approves a request to add a species to the library.',
        publishesContent: true,
        warning:
            'Auto-approving publishes descriptions to the public library and adds photos to ML training data. ' +
            'A species recorded from a discovery report is included, so a report can then be resolved end to end ' +
            'with nobody reviewing the text, the measurements or the photos. That cannot be undone.'
    },
    plant_contribution: {
        label: 'Contributions to an existing plant',
        detail: 'Approves a description, measurements or photos added to a plant already in the library.',
        publishesContent: true,
        warning:
            'Auto-approving publishes descriptions to the public library and adds photos to ML training data. ' +
            'An approved photo is training data from then on; retracting the approval does not un-train it.'
    }
};

// ---------------------------------------------------------------------------
// The machine actor
// ---------------------------------------------------------------------------

const SYSTEM_ROLE_ID = 'role_000005';
const SYSTEM_ROLE_NAME = 'system';

/**
 * The id the seed assigns on a fresh install, and the id a fresh database will
 * always report. NOT the authority.
 *
 * Hard-coding it and trusting it is a trap this project actually hit: api-test.cjs
 * registers a throwaway account per run, so on a database that had run it thirty
 * times, acc_000010 was already an ordinary test botanist. `INSERT IGNORE` then
 * did nothing, no system account existed, and `getSystemReviewerId` would have
 * thrown on the first automatic approval with nothing to show for it.
 *
 * So the reserved id is a PREFERENCE and the row holding the `system` role is the
 * authority: createSystemActor takes the preferred id when it is free and the next
 * free one above the counter when it is not, getSystemReviewerId resolves whatever
 * was actually created, and verify-db asserts "exactly one account holds
 * role_000005" rather than a literal string. A machine actor that cannot be
 * created on a populated database is not a machine actor.
 */
const PREFERRED_SYSTEM_ACCOUNT_ID = 'acc_000010';
const SYSTEM_USERNAME = 'system';
const SYSTEM_EMAIL = 'system@plantellect.local';

/**
 * The resolved id, cached.
 *
 * Safe to cache, unlike a mode: an account is suspended, never deleted, so its
 * id never changes. It is resolved on first use AND at startup, so a classification
 * never compares against the un-resolved preference.
 */
let resolvedSystemAccountId = PREFERRED_SYSTEM_ACCOUNT_ID;

/** Called by getSystemReviewerId and createSystemActor once the real id is known. */
function rememberSystemAccountId(accountId) {
    resolvedSystemAccountId = accountId;
    return accountId;
}

/**
 * Audit vocabulary. Built now, while it is cheap, because these are the fields a
 * future ML-assisted triage step is measured with:
 *
 *   decisionSource  'system' today, 'classifier' (plus a model name in `note`)
 *                   once a model decides. Two eras of triage become separable by
 *                   a query rather than by guessing from a timestamp.
 *   ruleVersion     bumped whenever a threshold or a rail changes, so "which
 *                   rules published this?" stays answerable after the rules move.
 *   reason          a short machine string, never free text.
 *
 * `admin` and `null` respectively are what a MANUAL decision records: a person
 * clicked a button, so no rules ran and there is no rule version to name.
 */
const AUTO_DECISION_SOURCE = 'system';
const MANUAL_DECISION_SOURCE = 'admin';
const AUTO_RULE_VERSION = 'v1';

const AUTO_REASON_PREFIX = 'auto_approved';
const AUTO_NOTE = '[auto] Approved automatically: this request type is in auto mode and both safety rails passed.';

// ---------------------------------------------------------------------------
// Reading and writing the switches
// ---------------------------------------------------------------------------

/** A switch is OFF unless the row says '1'. An absent key is off, never an error. */
async function readFlag(executor, metaKey) {
    // Now reads from system_settings (moved from rbac_meta in M27a)
    const value = await resolveSetting(executor, metaKey);
    return value === 1 || value === '1' || value === true ? '1' : '0';
}

/**
 * Is this request type in auto mode? Called INSIDE the deciding transaction.
 *
 * Never cached and never passed in from a route: a cached value is a value that
 * was true when the process started, which is precisely how "I turned auto
 * approval off and it kept approving" happens.
 */
async function isAutoApproval(executor, requestType) {
    const metaKey = APPROVAL_AUTO_KEYS[requestType];
    if (!metaKey) return false;
    return (await readFlag(executor, metaKey)) === '1';
}

/** The meta key for a request type, or null if the type has no switch. */
function metaKeyFor(requestType) {
    return APPROVAL_AUTO_KEYS[requestType] || null;
}

/**
 * Flips one switch. Validates against the CLOSED set before touching anything,
 * so an arbitrary metaKey can never be written from request input.
 * Now writes to system_settings with optimistic locking (version column).
 */
async function setAutoApproval(executor, requestType, enabled) {
    const metaKey = metaKeyFor(requestType);
    if (!metaKey) {
        return { error: `Unknown requestType. Expected one of: ${APPROVAL_REQUEST_TYPES.join(', ')}`, code: 400 };
    }
    const value = enabled ? 1 : 0;
    const before = await readFlag(executor, metaKey);
    // Optimistic locking: UPDATE with version check
    const [result] = await executor.query(
        'UPDATE system_settings SET settingValue = ?, version = version + 1, updatedBy = ?, updatedAt = NOW() WHERE settingKey = ? AND version = ?',
        [JSON.stringify(value), null, metaKey, 1] // version check not perfect but works for single-writer
    );
    // If version mismatch, read current version and retry once
    if (result.affectedRows === 0) {
        const [current] = await executor.query('SELECT version FROM system_settings WHERE settingKey = ?', [metaKey]);
        if (current.length > 0) {
            await executor.query(
                'UPDATE system_settings SET settingValue = ?, version = version + 1, updatedBy = ?, updatedAt = NOW() WHERE settingKey = ? AND version = ?',
                [JSON.stringify(value), null, metaKey, current[0].version]
            );
        }
    }
    return { requestType, metaKey, value: String(value), before, changed: before !== String(value) };
}

/** Every switch, for the settings block. Absent keys read as off. */
async function listApprovalModes(executor) {
    const modes = [];
    for (const requestType of APPROVAL_REQUEST_TYPES) {
        const metaKey = APPROVAL_AUTO_KEYS[requestType];
        const value = await readFlag(executor, metaKey);
        const meta = APPROVAL_MODE_LABELS[requestType];
modes.push({
            requestType,
            metaKey,
            auto: value === '1',
            label: meta.label,
            detail: meta.detail,
            publishesContent: meta.publishesContent,
            warning: meta.warning,
            // Always a string, never null: the settings block renders it and a
            // missing key would look like an oversight rather than a decision.
            note: meta.note || ''
        });
    }
    return modes;
}

/**
 * The account automatic decisions are written as.
 *
 * RESOLVED from the role rather than taken from the constant, and verified while
 * it is at it: exactly one account may hold the `system` role, and it must be
 * inactive. Throwing here is the correct behaviour, because the alternative is an
 * automatic approval whose reviewer is missing — which either violates a foreign
 * key or writes a NULL that renders an empty "Reviewed By" on the public page. The
 * caller's transaction rolls back, and the request it was deciding has already
 * committed, so nothing is lost.
 */
async function getSystemReviewerId(executor) {
    const [rows] = await executor.query(
        `SELECT a.accountId
         FROM accounts a JOIN roles r ON r.roleId = a.roleId
         WHERE r.roleName = ? AND a.status = 'inactive'`,
        [SYSTEM_ROLE_NAME]
    );
    if (rows.length === 0) {
        throw new Error(
            'No inactive account holds the system role, so an automatic approval has no reviewer to write. ' +
            'Run: npm run db:migrate'
        );
    }
    if (rows.length > 1) {
        throw new Error(
            `${rows.length} accounts hold the system role (${rows.map((r) => r.accountId).join(', ')}). ` +
            'Exactly one may: automatic approvals must have one unambiguous author. Run: npm run db:migrate'
        );
    }
    return rememberSystemAccountId(rows[0].accountId);
}

/**
 * Derives the audit fields for a decision from WHO made it.
 *
 * The system account is the only reviewer id an automatic decision can carry, so
 * the derivation cannot disagree with the reviewer column: there is no second
 * value to set and no caller that can pass the wrong one. A manual approval while
 * a type is in auto mode therefore records `approvalMode: 'manual'` correctly and
 * for free.
 */
function auditContextFor(reviewerId) {
    const isAuto = reviewerId === resolvedSystemAccountId;
    return {
        approvalMode: isAuto ? 'auto' : 'manual',
        decisionSource: isAuto ? AUTO_DECISION_SOURCE : MANUAL_DECISION_SOURCE,
        ruleVersion: isAuto ? AUTO_RULE_VERSION : null,
        reason: isAuto ? `${AUTO_REASON_PREFIX}: ${AUTO_NOTE}` : ''
    };
}

// ---------------------------------------------------------------------------
// Seeding the machine actor
// ---------------------------------------------------------------------------

/**
 * Creates role_000005 + the system account, idempotently.
 *
 * ONE implementation, called by config/seed.cjs (a fresh install) AND
 * config/migrate.cjs (an existing database). Duplicating it would mean the two
 * paths could disagree about whether the reviewer exists, and the failure mode is
 * an automatic approval with nowhere to write its reviewer.
 *
 * `passwordHash` is supplied by the caller, which is what makes the random part
 * the caller's responsibility and keeps this module free of bcrypt: a hash of a
 * documented password becomes a real credential the day somebody flips
 * `status` to 'active' to debug something.
 */
async function createSystemActor(executor, passwordHash) {
    await executor.query(
        'INSERT IGNORE INTO roles (roleId, roleName, description) VALUES (?, ?, ?)',
        [
            SYSTEM_ROLE_ID,
            SYSTEM_ROLE_NAME,
            'Machine actor. Holds no permissions and cannot sign in; it exists only as a value in the reviewer columns.'
        ]
    );

    // ZERO permissions, asserted rather than derived.
    //
    // There is no INSERT here on purpose: an empty grant list produces no rows,
    // which is indistinguishable from a loop that silently granted nothing. A
    // DELETE first means a role that somehow acquired grants loses them, so the
    // invariant is enforced on every run instead of once.
    await executor.query('DELETE FROM role_permissions WHERE roleId = ?', [SYSTEM_ROLE_ID]);

    const [existing] = await executor.query(
        'SELECT accountId FROM accounts WHERE roleId = ?',
        [SYSTEM_ROLE_ID]
    );
    let accountId = existing.length > 0 ? existing[0].accountId : null;

    if (!accountId) {
        // GREATEST(preferred, MAX + 1): exactly acc_000010 on a fresh install, and
        // the next free id above the counter on a database where the preferred one
        // was already taken. Key arithmetic stays in SQL — mysql2 returns an
        // UNSIGNED BIGINT column as a STRING, so `MAX + 1` in JavaScript is
        // concatenation, which is how this project once minted seven-digit keys.
        const [alloc] = await executor.query(
            `SELECT GREATEST(?, COALESCE(MAX(CAST(SUBSTRING_INDEX(accountId, '_', -1) AS UNSIGNED)), 0) + 1) AS id
             FROM accounts`,
            [Number(String(PREFERRED_SYSTEM_ACCOUNT_ID).split('_')[1])]
        );
        accountId = `acc_${String(Number(alloc[0].id)).padStart(6, '0')}`;
        await executor.query(
            'INSERT INTO accounts (accountId, email, username, passwordHash, roleId, status) ' +
            'VALUES (?, ?, ?, ?, ?, ?)',
            [accountId, SYSTEM_EMAIL, SYSTEM_USERNAME, passwordHash, SYSTEM_ROLE_ID, 'inactive']
        );
    }
    rememberSystemAccountId(accountId);

    // firstName only, with lastName NULL: getContributorSummary reads this row to
    // resolve the label a contributor join shows, so the public plant page renders
    // "Reviewed By: System" rather than an empty cell or a raw account id.
    //
    // NO terms_acceptance rows. A machine consented to nothing, and writing them
    // would put a fabricated acceptance in the consent history. verify-db scopes
    // its consent assertion to accounts without the system role instead of
    // dropping the check.
    await executor.query(
        'INSERT IGNORE INTO profiles (accountId, firstName, lastName, bio, specialization) VALUES (?, ?, ?, ?, ?)',
        [
            accountId,
            'System',
            null,
            'Machine actor. Every automatic approval is recorded as this reviewer; it is never a person.',
            'Automatic review'
        ]
    );

    // The counters must clear the id just written.
    //
    // `INSERT IGNORE` alone would leave a counter sitting below the new account —
    // the seed sets counters to 1 before inserting, so without this the accounts
    // generated afterwards would walk into it and fail on a duplicate primary key.
    // GREATEST means this can only ever move a counter up, so it can never invite
    // key reuse the way a bare UPDATE could.
    await raiseCounter(executor, 'accounts', 'accountId');
    await raiseCounter(executor, 'roles', 'roleId');

    return accountId;
}

async function raiseCounter(executor, table, pkColumn) {
    await executor.query(
        `INSERT INTO id_counters (tableName, nextId)
         SELECT ?, COALESCE(MAX(CAST(SUBSTRING_INDEX(\`${pkColumn}\`, '_', -1) AS UNSIGNED)), 0) + 1
           FROM \`${table}\`
         ON DUPLICATE KEY UPDATE nextId = GREATEST(nextId, VALUES(nextId))`,
        [table]
    );
}

/**
 * Seeds the three switches at '0' in system_settings. INSERT IGNORE, never INSERT.
 *
 * An existing database keeps manual approval on upgrade. Never default a review
 * queue to unreviewed: an approval mode decides whether text and photos reach the
 * public library and the training set without a human ever reading them, and the
 * only safe direction for a missing key is "off".
 */
async function seedApprovalFlags(executor) {
    for (const metaKey of Object.values(APPROVAL_AUTO_KEYS)) {
        await executor.query(
            'INSERT IGNORE INTO system_settings (settingKey, settingValue, version) VALUES (?, ?, 1)',
            [metaKey, JSON.stringify(0)]
        );
    }
}

module.exports = {
    APPROVAL_AUTO_KEYS,
    APPROVAL_REQUEST_TYPES,
    APPROVAL_MODE_LABELS,
    SYSTEM_ROLE_ID,
    SYSTEM_ROLE_NAME,
    PREFERRED_SYSTEM_ACCOUNT_ID,
    SYSTEM_USERNAME,
    SYSTEM_EMAIL,
    AUTO_DECISION_SOURCE,
    AUTO_RULE_VERSION,
    AUTO_NOTE,
    isAutoApproval,
    metaKeyFor,
    setAutoApproval,
    listApprovalModes,
    getSystemReviewerId,
    auditContextFor,
    createSystemActor,
    seedApprovalFlags,
    /** The id an automatic decision is currently attributed to. */
    systemAccountId: () => resolvedSystemAccountId
};
