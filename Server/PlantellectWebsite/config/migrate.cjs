/**
 * Idempotent, non-destructive schema migration.
 *
 *   npm run db:migrate
 *
 * `db:reset` is the documented development default while there is no data worth
 * keeping, but anyone with a populated database needs this instead: runSeed()
 * early-returns on an existing database, so it will never apply a schema change.
 * Nothing here drops or rewrites data — every step either creates a missing
 * object, widens a column, or inserts a row that is absent.
 *
 * RUN IT TWICE IN A ROW BEFORE SERVING ANYTHING. The second run exercises every
 * guard's already-applied branch, which is the only practical way to catch a
 * migration that applied its ALTER and then failed on a data statement — a state
 * neither the guards nor the startup preflight necessarily reports, and one
 * that surfaces later as a 500 on a feature path rather than a startup error.
 * A partially-migrated database is the single most likely way this project gets
 * into a broken state, and running the command twice costs nothing.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const settings = require('./settings');
const { PK_COLUMNS } = require('./ids.js');
const { resolveSetting } = require('./limits.js');

function createPool() {
    return mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME,
        charset: 'utf8mb4',
        timezone: settings.system.timezone,
        connectionLimit: 2
    });
}

const applied = [];
const skipped = [];

async function columnInfo(conn, table, column) {
    const [rows] = await conn.query(
        `SELECT column_name AS columnName, is_nullable AS isNullable, column_type AS columnType
         FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
    );
    return rows[0] || null;
}

async function tableExists(conn, table) {
    const [rows] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ?`,
        [table]
    );
    return rows[0].n > 0;
}

async function indexExists(conn, table, indexName) {
    const [rows] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, indexName]
    );
    return rows[0].n > 0;
}

/**
 * Whether the named column already carries an outbound foreign key.
 *
 * Checked separately from the column itself because the two can disagree: a
 * migration interrupted between `ADD COLUMN` and `ADD FOREIGN KEY` leaves a
 * column with no FK, and "the column exists" would then report the step as
 * already applied when half of it is missing.
 */
async function foreignKeyExists(conn, table, column) {
    const [rows] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
           AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [table, column]
    );
    return rows[0].n > 0;
}

/** True when the column's COLUMN_TYPE is exactly the expected ENUM value list. */
async function enumIs(conn, table, column, expected) {
    const info = await columnInfo(conn, table, column);
    if (!info) return false;
    const wanted = `enum(${expected.map((v) => `'${v}'`).join(',')})`;
    return String(info.columnType).toLowerCase() === wanted;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * plant_description.partsId becomes nullable.
 *
 * It was NOT NULL, so a submission with text but no measurements produced no
 * description row at all — and because public visibility requires an approved
 * primary description, the plant never appeared in the library while the
 * botanist saw "Approved" in their submissions. Widening the column is what
 * lets approvePlantRequest insert a description for text OR measurements.
 */
async function migrateDescriptionPartsId(conn) {
    const info = await columnInfo(conn, 'plant_description', 'partsId');
    if (!info) {
        throw new Error('plant_description.partsId does not exist. Run "npm run db:reset" for a fresh database.');
    }
    if (String(info.isNullable).toUpperCase() === 'YES') {
        skipped.push('plant_description.partsId is already nullable');
        return;
    }
    await conn.query('ALTER TABLE plant_description MODIFY partsId VARCHAR(18) DEFAULT NULL');
    applied.push('plant_description.partsId -> NULL');
}

/** The durable scan-quota counter. */
async function migrateScanUsageTable(conn) {
    if (await tableExists(conn, 'ml_scan_usage')) {
        skipped.push('ml_scan_usage already exists');
        return;
    }
    await conn.query(`
        CREATE TABLE ml_scan_usage (
            accountId VARCHAR(18) NOT NULL,
            windowStart DATETIME NOT NULL,
            scansUsed INT NOT NULL DEFAULT 0,
            updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (accountId, windowStart),
            FOREIGN KEY (accountId) REFERENCES accounts(accountId) ON DELETE CASCADE,
            INDEX idx_usage_window (windowStart)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    applied.push('created ml_scan_usage');
}

/**
 * discovery_images, plus its id_counters row.
 *
 * Document 1 created this table HERE ONLY, never in config/seed.cjs, because
 * the id_counters row it needs is the one step seedData() cannot perform on an
 * existing database. Document 2's P2 fixes the other half: seed.cjs now creates
 * the table too, so `db:reset` + `npm start` alone is a complete install and the
 * scratch-machine loop does not depend on running this migration.
 *
 * ORDER IS MANDATORY: the CREATE must precede the INSERT IGNORE, or the seed
 * fails on a missing table. The schema below and the one in seed.cjs are the
 * same definition, so either path reaching an existing table skips.
 */
async function migrateDiscoveryImages(conn) {
    if (await tableExists(conn, 'discovery_images')) {
        skipped.push('discovery_images already exists');
    } else {
        await conn.query(`
            CREATE TABLE discovery_images (
                imageId VARCHAR(18) NOT NULL PRIMARY KEY,
                requestId VARCHAR(18) NOT NULL,
                accountId VARCHAR(18) NOT NULL,
                originalFilename VARCHAR(255) NOT NULL,
                storedPath VARCHAR(500) NOT NULL,
                mimeType VARCHAR(100) NOT NULL,
                size BIGINT NOT NULL,
                uploadedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (requestId) REFERENCES approval_requests(requestId) ON DELETE CASCADE,
                FOREIGN KEY (accountId) REFERENCES accounts(accountId) ON DELETE CASCADE,
                INDEX idx_discovery_request (requestId)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        applied.push('created discovery_images');
    }

    // Targeted, insert-only. syncCounters() is NOT the right tool here: it does
    // ON DUPLICATE KEY UPDATE nextId = VALUES(nextId) with maxId + 1, so a
    // counter sitting at 500 while the table's highest key is 100 would be
    // LOWERED to 101, inviting key reuse. It also queries FROM <table> for every
    // registered table, so it throws while discovery_images does not exist.
    // INSERT IGNORE never lowers an existing counter, and computing MAX(id) + 1
    // means a partially populated table resumes above its highest key.
    const [beforeRows] = await conn.query(
        "SELECT nextId FROM id_counters WHERE tableName = 'discovery_images'"
    );
    await conn.query(
        `INSERT IGNORE INTO id_counters (tableName, nextId)
         SELECT 'discovery_images',
                COALESCE(MAX(CAST(SUBSTRING_INDEX(\`imageId\`, '_', -1) AS UNSIGNED)), 0) + 1
           FROM \`discovery_images\``
    );
    const [afterRows] = await conn.query(
        "SELECT nextId FROM id_counters WHERE tableName = 'discovery_images'"
    );
    if (beforeRows.length === 0) {
        applied.push(`seeded id_counters row for discovery_images (nextId=${afterRows[0].nextId})`);
    } else if (beforeRows[0].nextId !== afterRows[0].nextId) {
        // A pre-existing counter is never rewritten by INSERT IGNORE, so a change
        // here would mean something else moved it. Say so rather than hide it.
        console.log(`  note: discovery_images counter moved ${beforeRows[0].nextId} -> ${afterRows[0].nextId}`);
        applied.push(`id_counters row for discovery_images now ${afterRows[0].nextId}`);
    } else {
        skipped.push(`id_counters row for discovery_images already at ${afterRows[0].nextId}`);
    }

    // Same rule for any other single-column-key table added downstream.
    // NOT for discovery_votes or ml_scan_usage: composite primary keys, no
    // ids.js entry, and correctly no counter row.
    for (const table of Object.keys(PK_COLUMNS)) {
        if (table === 'discovery_images') continue;
        if (!(await tableExists(conn, table))) continue;
        await conn.query(
            `INSERT IGNORE INTO id_counters (tableName, nextId)
             SELECT ?, COALESCE(MAX(CAST(SUBSTRING_INDEX(\`${PK_COLUMNS[table]}\`, '_', -1) AS UNSIGNED)), 0) + 1
               FROM \`${table}\``,
            [table]
        );
    }
}

/**
 * The "not a plant" quorum ballot.
 *
 * No id_counters row, ever: the primary key is (requestId, accountId), so there
 * is no single key column to allocate from and a counter would be meaningless.
 */
async function migrateDiscoveryVotes(conn) {
    if (await tableExists(conn, 'discovery_votes')) {
        skipped.push('discovery_votes already exists');
        return;
    }
    await conn.query(`
        CREATE TABLE discovery_votes (
            requestId VARCHAR(18) NOT NULL,
            accountId VARCHAR(18) NOT NULL,
            votedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (requestId, accountId),
            FOREIGN KEY (requestId) REFERENCES approval_requests(requestId) ON DELETE CASCADE,
            FOREIGN KEY (accountId) REFERENCES accounts(accountId) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    applied.push('created discovery_votes');
}

/**
 * approval_requests.requestType and .status.
 *
 * ONE statement, because three tasks depend on the same two columns:
 * adds 'plant_discovery',  adds 'cancelled' and  adds 'rejected'.
 * Quoting only the requestType form here would leave the status enum at three
 * values and both later features would fail on the first write.
 *
 * Guarded on the exact COLUMN_TYPE, not on the column existing: an existing
 * enum with three values passes any "does it exist" check while the report
 * endpoint would 500 on insert.
 */
async function migrateApprovalRequestEnums(conn) {
    const REQUEST_TYPES = ['role_permission', 'plant_addition', 'plant_contribution', 'plant_discovery'];
    const STATUSES = ['pending', 'approved', 'denied', 'cancelled', 'rejected'];

    const clauses = [];
    if (!(await enumIs(conn, 'approval_requests', 'requestType', REQUEST_TYPES))) {
        clauses.push(
            `MODIFY requestType ENUM(${REQUEST_TYPES.map((v) => `'${v}'`).join(',')})`
        );
    }
    if (!(await enumIs(conn, 'approval_requests', 'status', STATUSES))) {
        clauses.push(`MODIFY status ENUM(${STATUSES.map((v) => `'${v}'`).join(',')})`);
    }

    if (clauses.length === 0) {
        skipped.push('approval_requests requestType and status enums already widened');
        return;
    }
    await conn.query(`ALTER TABLE approval_requests ${clauses.join(', ')}`);
    applied.push(`widened approval_requests enums (${clauses.length} column(s))`);
}

/**
 * plant_contributors gains 'reporter' — the person who filed the discovery
 * report that produced the plant. Credit, not authorship: the 'contributor' row
 * and plant_description.accountId stay with the botanist who wrote the text.
 */
async function migrateContributorReporterRole(conn) {
    const ROLES = ['contributor', 'reviewer', 'reporter'];
    if (await enumIs(conn, 'plant_contributors', 'role', ROLES)) {
        skipped.push('plant_contributors.role already includes reporter');
        return;
    }
    if (!(await columnInfo(conn, 'plant_contributors', 'role'))) {
        throw new Error('plant_contributors.role does not exist. Run "npm run db:reset" for a fresh database.');
    }
    await conn.query(
        `ALTER TABLE plant_contributors MODIFY role ENUM(${ROLES.map((v) => `'${v}'`).join(',')})`
    );
    applied.push('plant_contributors.role -> contributor, reviewer, reporter');
}

/**
 * The claim / resolve / disqualify columns on approval_requests.
 *
 * This is the SINGLE authoritative column list for approval_requests across
 * claimSource are one ALTER group here and nowhere else. approvalMode  rides along because it is the same kind of column and the same
 * table; it is harmless before document 3 exists, since every row defaults to
 * 'manual'.
 *
 * Column, FK and index are each checked separately. A migration interrupted
 * between two statements leaves some present and some not, and a single
 * "does the column exist" guard would then report the whole step as applied
 * while half of it is missing — exactly the state the run-twice rule exists to
 * expose.
 */
async function migrateDiscoveryClaimColumns(conn) {
    const COLUMNS = [
        //  the claim
        ['claimedBy', 'VARCHAR(18) DEFAULT NULL'],
        ['claimedAt', 'TIMESTAMP NULL DEFAULT NULL'],
        // the botanist's close
        ['resolvedBy', 'VARCHAR(18) DEFAULT NULL'],
        ['resolvedAt', 'TIMESTAMP NULL DEFAULT NULL'],
        //  the record this produced
        ['recordRequestId', 'VARCHAR(18) DEFAULT NULL'],
        //  "not a plant"
        ['disqualifiedBy', 'VARCHAR(18) DEFAULT NULL'],
        ['disqualifiedAt', 'TIMESTAMP NULL DEFAULT NULL'],
        ['disqualifyReason', 'VARCHAR(32) DEFAULT NULL'],
        //  how this decision was reached
        ["approvalMode", "ENUM('manual','auto') NOT NULL DEFAULT 'manual'"],
        //  chosen, or assigned by the dispatcher
        ["claimSource", "ENUM('manual','auto') NOT NULL DEFAULT 'manual'"]
    ];
    // The referenced column is named explicitly rather than assumed equal to the
    // local one: claimedBy references accounts(accountId), and only
    // recordRequestId's self-reference happens to share its name.
    const FOREIGN_KEYS = [
        ['claimedBy', 'accounts', 'accountId', 'ON DELETE SET NULL'],
        ['resolvedBy', 'accounts', 'accountId', 'ON DELETE SET NULL'],
        ['recordRequestId', 'approval_requests', 'requestId', 'ON DELETE SET NULL'],
        ['disqualifiedBy', 'accounts', 'accountId', 'ON DELETE SET NULL']
    ];
    const INDEXES = [
        ['idx_requests_claimed', 'claimedBy'],
        ['idx_requests_resolved', 'resolvedBy'],
        ['idx_requests_record', 'recordRequestId']
    ];

    const missing = [];
    for (const [column, definition] of COLUMNS) {
        if (!(await columnInfo(conn, 'approval_requests', column))) {
            missing.push(`ADD COLUMN ${column} ${definition}`);
        }
    }
    if (missing.length > 0) {
        await conn.query(`ALTER TABLE approval_requests ${missing.join(', ')}`);
        applied.push(`added ${missing.length} discovery column(s) to approval_requests`);
    } else {
        skipped.push('approval_requests discovery columns already present');
    }

    const missingFks = [];
    for (const [column, refTable, refColumn, onDelete] of FOREIGN_KEYS) {
        if (!(await foreignKeyExists(conn, 'approval_requests', column))) {
            missingFks.push(
                `ADD FOREIGN KEY (${column}) REFERENCES ${refTable}(${refColumn}) ${onDelete}`
            );
        }
    }
    if (missingFks.length > 0) {
        await conn.query(`ALTER TABLE approval_requests ${missingFks.join(', ')}`);
        applied.push(`added ${missingFks.length} discovery foreign key(s) to approval_requests`);
    } else {
        skipped.push('approval_requests discovery foreign keys already present');
    }

    const missingIndexes = [];
    for (const [name, column] of INDEXES) {
        if (!(await indexExists(conn, 'approval_requests', name))) {
            missingIndexes.push(`ADD INDEX ${name} (${column})`);
        }
    }
    if (missingIndexes.length > 0) {
        await conn.query(`ALTER TABLE approval_requests ${missingIndexes.join(', ')}`);
        applied.push(`added ${missingIndexes.length} discovery index(es) to approval_requests`);
    } else {
        skipped.push('approval_requests discovery indexes already present');
    }
}

/**
 * Recomputes every single-column-key counter as MAX(suffix) + 1.
 *
 * This REPAIRS counters rather than seeding them, and it exists because a
 * counter can be wrong in a way nothing else notices. config/seed.cjs's
 * syncCounters() read an UNSIGNED BIGINT as a string and did `maxId + 1` in
 * JavaScript, so `'200005' + 1` was the string `'2000051'`: every
 * terms_acceptance key written afterwards carried a SEVEN-digit suffix, and
 * `npm run verify:db` failed on a database that had just been reset. A database
 * that was never reset keeps those counters forever, because the seed early
 * returns on an existing one.
 *
 * SAFE to recompute, which is the part worth being sure about: a counter only
 * ever hands out numbers, and any number it has already handed out is either in
 * the table (so MAX covers it) or belongs to a transaction that rolled back
 * (so its number was never used). MAX + 1 therefore cannot collide.
 *
 * The arithmetic stays in SQL. Doing `maxId + 1` in JavaScript here would
 * reintroduce exactly the bug this step exists to clean up.
 *
 * NOT discovery_votes, role_permissions or ml_scan_usage: composite primary
 * keys, no ids.js entry, and correctly no counter.
 */
async function repairIdCounters(conn) {
    let repaired = 0;
    for (const table of Object.keys(PK_COLUMNS)) {
        if (!(await tableExists(conn, table))) continue;
        const [rows] = await conn.query(
            `SELECT nextId FROM id_counters WHERE tableName = ?`,
            [table]
        );
        const [maxRows] = await conn.query(
            `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(\`${PK_COLUMNS[table]}\`, '_', -1) AS UNSIGNED)), 0) + 1 AS expected
             FROM \`${table}\``
        );
        const expected = Number(maxRows[0].expected);
        const current = rows.length > 0 ? Number(rows[0].nextId) : null;

        if (rows.length === 0) {
            await conn.query(
                'INSERT INTO id_counters (tableName, nextId) VALUES (?, ?)',
                [table, expected]
            );
            repaired++;
            continue;
        }
        if (current !== expected) {
            // Reported rather than silently applied: a difference here is either
            // the string-concatenation bug, or somebody's hand edit, and both are
            // worth a line in the migration log.
            await conn.query(
                'UPDATE id_counters SET nextId = ? WHERE tableName = ?',
                [expected, table]
            );
            applied.push(`repaired id_counters.${table}: ${rows[0].nextId} -> ${expected}`);
            repaired++;
        }
    }
    if (repaired === 0) {
        skipped.push(`all ${Object.keys(PK_COLUMNS).length} id_counters rows match MAX(id) + 1`);
    } else {
        applied.unshift(`repaired ${repaired} id_counters row(s)`);
    }
}
/**
 * The auto-dispatch switch. Absent means off — the startup preflight and
 * getDiscoveryFeatureFlag both default it to '0' — so this row is a convenience
 * that makes the flag discoverable rather than a prerequisite.
 */
async function migrateDiscoveryAutoDispatchFlag(conn) {
    const [rows] = await conn.query(
        "SELECT metaValue FROM rbac_meta WHERE metaKey = 'discovery_auto_dispatch'"
    );
    if (rows.length > 0) {
        skipped.push(`discovery_auto_dispatch already set to '${rows[0].metaValue}'`);
        return;
    }
    await conn.query("INSERT INTO rbac_meta (metaKey, metaValue) VALUES ('discovery_auto_dispatch', '0')");
    applied.push('added rbac_meta discovery_auto_dispatch = 0');
}

/**
 * role_000005 + the system account + the three approval_auto_* switches.
 *
 * A database created before automatic approval existed has no
 * machine actor, so switching any approval mode on there would have nowhere to
 * write a reviewer: every automatic decision would write a NULL into columns that
 * are real foreign keys, and the public page would render an empty "Reviewed By".
 * That is a silent failure — the decision succeeds and simply has no author — so
 * the row is migrated rather than left to whoever first flips a switch.
 *
 * The SAME function config/seed.cjs calls does the work, so a fresh install and an
 * upgraded one cannot end up with different machine actors. The random throwaway
 * password hash is generated per run rather than reused: `INSERT IGNORE` means an
 * existing system account is never touched, and there is no reason for two
 * databases to share a hash even for a credential nobody can use.
 *
 * Ordered before repairIdCounters, though createSystemActor raises the two
 * counters it needs itself — belt and braces, because that step is the authority
 * and this one should not depend on it having run.
 */
async function migrateApprovalModeSetup(conn) {
    const approvalMode = require('./approval-mode.js');
    const bcrypt = require('bcrypt');
    const crypto = require('crypto');

    const [roleRows] = await conn.query('SELECT roleId FROM roles WHERE roleName = ?', [approvalMode.SYSTEM_ROLE_NAME]);
    const [accountRows] = await conn.query(
        'SELECT a.accountId FROM accounts a JOIN roles r ON r.roleId = a.roleId WHERE r.roleName = ?',
        [approvalMode.SYSTEM_ROLE_NAME]
    );
    const existed = roleRows.length > 0 && accountRows.length > 0;

    // A NEW random hash each run, deliberately: createSystemActor only inserts the
    // account when the role has none, so an existing one is never touched, and
    // there is no reason for two databases to share a hash even for a credential
    // nobody can use.
    const accountId = await approvalMode.createSystemActor(
        conn,
        bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10)
    );
    await approvalMode.seedApprovalFlags(conn);

    if (existed) {
        skipped.push(`system reviewer ${accountId} and the approval_auto_* switches already present`);
    } else {
        applied.push(`added the system reviewer (${accountId}) and the three approval_auto_* switches`);
    }
}

/**
 * view_plants for role_000004 (the plain `user` role), plus the version bump.
 *
 * The permission is declared at config/seed.cjs and granted to botanists, but
 * nothing read it. Granting it to `user` records the intent ("a signed-in
 * account may browse the library") WITHOUT implying the library is protected:
 * GET /api/plants stays a public route with no middleware. Do not add a gate
 * there to make the permission "real" — that locks out guests, which is not
 * what it is for.
 *
 * The bump is what makes live sessions pick it up: requireAuth compares the
 * session's permissionsVersion against rbac_meta and reloads on a mismatch.
 */
async function migrateUserViewPlants(conn) {
    const [beforeRows] = await conn.query(
        `SELECT rp.permissionId AS permissionId FROM role_permissions rp
         JOIN permissions p ON p.permissionId = rp.permissionId
         WHERE rp.roleId = 'role_000004' AND p.permissionName = 'view_plants'`
    );
    if (beforeRows.length > 0) {
        skipped.push('view_plants already granted to role_000004');
        return;
    }

    await conn.query(
        `INSERT IGNORE INTO role_permissions (roleId, permissionId)
         SELECT 'role_000004', permissionId FROM permissions WHERE permissionName = 'view_plants'`
    );
    applied.push('granted view_plants to role_000004');

    // The bump is what makes live sessions pick it up: requireAuth compares the
    // session's permissionsVersion against rbac_meta and reloads on a mismatch.
    // Only on the run that actually changed the grant, so a repeat run is inert.
    await conn.query(
        "UPDATE rbac_meta SET metaValue = metaValue + 1 WHERE metaKey = 'permissions_version'"
    );
    applied.push('bumped permissions_version');
}

/**
 * system_settings table (M27).
 * Creates the table if it doesn't exist, checking each column separately.
 */
async function migrateSystemSettingsTable(conn) {
    if (await tableExists(conn, 'system_settings')) {
        skipped.push('system_settings already exists');
    } else {
        await conn.query(`
            CREATE TABLE system_settings (
                settingKey VARCHAR(64) PRIMARY KEY,
                settingValue JSON NOT NULL,
                version INT NOT NULL DEFAULT 1,
                updatedBy VARCHAR(18) NULL,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (updatedBy) REFERENCES accounts(accountId) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        applied.push('created system_settings');
    }
}

/**
 * role_limits table (M27).
 * Creates the table if it doesn't exist, checking each column separately.
 */
async function migrateRoleLimitsTable(conn) {
    if (await tableExists(conn, 'role_limits')) {
        skipped.push('role_limits already exists');
    } else {
        await conn.query(`
            CREATE TABLE role_limits (
                roleId VARCHAR(18) NOT NULL,
                limitKey VARCHAR(64) NOT NULL,
                limitValue JSON NOT NULL,
                PRIMARY KEY (roleId, limitKey),
                FOREIGN KEY (roleId) REFERENCES roles(roleId) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        applied.push('created role_limits');
    }
}

/**
 * Move approval_auto_* and discovery_auto_dispatch from rbac_meta to system_settings (M27a).
 * For each key: read from rbac_meta, write to system_settings, delete from rbac_meta.
 */
async function migrateFlagsToSystemSettings(conn) {
    const keysToMove = [
        'approval_auto_role_permission',
        'approval_auto_plant_addition',
        'approval_auto_plant_contribution',
        'discovery_auto_dispatch'
    ];

    for (const key of keysToMove) {
        const [rows] = await conn.query(
            "SELECT metaValue FROM rbac_meta WHERE metaKey = ?",
            [key]
        );
        if (rows.length > 0) {
            const value = rows[0].metaValue;
            // Write to system_settings (INSERT IGNORE so existing wins)
            await conn.query(
                'INSERT IGNORE INTO system_settings (settingKey, settingValue) VALUES (?, ?)',
                [key, value]
            );
            // Delete from rbac_meta
            await conn.query("DELETE FROM rbac_meta WHERE metaKey = ?", [key]);
            applied.push(`moved ${key} from rbac_meta to system_settings`);
        } else {
            skipped.push(`${key} not in rbac_meta (already moved or never seeded)`);
        }
    }
}

/**
 * Seed role_limits for 4 roles (M28).
 */
async function migrateSeedRoleLimits(conn) {
    const limits = {
        user: {
            maxOpenReportsPerAccount: 10,
            rateLimitMax: 30
        },
        botanist: {
            maxClaimsPerBotanist: 20,
            maxOpenReportsPerAccount: 10,
            rateLimitMax: 30
        },
        admin: {
            maxClaimsPerBotanist: 20,
            maxOpenReportsPerAccount: 10,
            rateLimitMax: 30
        },
        superadmin: {
            maxClaimsPerBotanist: 20,
            maxOpenReportsPerAccount: 10,
            rateLimitMax: 30
        }
    };

    for (const [roleName, roleLimits] of Object.entries(limits)) {
        const [roleRows] = await conn.query('SELECT roleId FROM roles WHERE roleName = ?', [roleName]);
        if (roleRows.length === 0) continue;
        const roleId = roleRows[0].roleId;

        for (const [limitKey, limitValue] of Object.entries(roleLimits)) {
            const [existing] = await conn.query(
                'SELECT 1 FROM role_limits WHERE roleId = ? AND limitKey = ?',
                [roleId, limitKey]
            );
            if (existing.length === 0) {
                await conn.query(
                    'INSERT INTO role_limits (roleId, limitKey, limitValue) VALUES (?, ?, ?)',
                    [roleId, limitKey, JSON.stringify(limitValue)]
                );
                applied.push(`seeded role_limits ${roleId}.${limitKey}`);
            } else {
                skipped.push(`role_limits ${roleId}.${limitKey} already exists`);
            }
        }
    }
}

/**
 * Seed system_settings rows: discoveries, mlRequest, mlConfidence, mlActiveModel (M30).
 */
async function migrateSeedSystemSettings(conn) {
    // discoveries
    const discoveriesValue = JSON.stringify({
        maxClaimsPerBotanist: 20,
        maxOpenReportsPerAccount: 10,
        cancelGraceHours: 24,
        reportCooldownMinutes: 10,
        claimStaleDays: 90,
        notAPlantVotes: 5,
        discoveryClosedPhotoDays: 90
    });
    const [discRows] = await conn.query(
        'SELECT 1 FROM system_settings WHERE settingKey = ?', ['discoveries']
    );
    if (discRows.length === 0) {
        await conn.query(
            'INSERT INTO system_settings (settingKey, settingValue) VALUES (?, ?)',
            ['discoveries', discoveriesValue]
        );
        applied.push('seeded system_settings.discoveries');
    } else {
        skipped.push('system_settings.discoveries already exists');
    }

    // mlRequest
    const mlRequestValue = JSON.stringify({ maxTopK: 10 });
    const [mlReqRows] = await conn.query(
        'SELECT 1 FROM system_settings WHERE settingKey = ?', ['mlRequest']
    );
    if (mlReqRows.length === 0) {
        await conn.query(
            'INSERT INTO system_settings (settingKey, settingValue) VALUES (?, ?)',
            ['mlRequest', mlRequestValue]
        );
        applied.push('seeded system_settings.mlRequest');
    } else {
        skipped.push('system_settings.mlRequest already exists');
    }

    // mlConfidence (M25b - per-model)
    const mlConfidenceValue = JSON.stringify({
        efficientnetv2b1: { mode: 'off', acceptThreshold: 0.70, uncertainThreshold: 0.35, marginThreshold: 0.15 },
        convnexttiny: { mode: 'off', acceptThreshold: 0.70, uncertainThreshold: 0.35, marginThreshold: 0.15 }
    });
    const [mlConfRows] = await conn.query(
        'SELECT 1 FROM system_settings WHERE settingKey = ?', ['mlConfidence']
    );
    if (mlConfRows.length === 0) {
        await conn.query(
            'INSERT INTO system_settings (settingKey, settingValue) VALUES (?, ?)',
            ['mlConfidence', mlConfidenceValue]
        );
        applied.push('seeded system_settings.mlConfidence');
    } else {
        skipped.push('system_settings.mlConfidence already exists');
    }

    // mlActiveModel (Option A - object with modelId)
    const mlActiveModelValue = JSON.stringify({ modelId: 'efficientnetv2b1' });
    const [mlActiveRows] = await conn.query(
        'SELECT 1 FROM system_settings WHERE settingKey = ?', ['mlActiveModel']
    );
    if (mlActiveRows.length === 0) {
        await conn.query(
            'INSERT INTO system_settings (settingKey, settingValue) VALUES (?, ?)',
            ['mlActiveModel', mlActiveModelValue]
        );
        applied.push('seeded system_settings.mlActiveModel');
    } else {
        skipped.push('system_settings.mlActiveModel already exists');
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const STEPS = [
    ['plant_description.partsId nullable', migrateDescriptionPartsId],
    ['ml_scan_usage table', migrateScanUsageTable],
    ['discovery_images table + counter row', migrateDiscoveryImages],
    ['discovery_votes table', migrateDiscoveryVotes],
    ['approval_requests requestType + status enums', migrateApprovalRequestEnums],
    ['plant_contributors.reporter role', migrateContributorReporterRole],
    ['approval_requests claim / resolve / disqualify columns', migrateDiscoveryClaimColumns],
    ['rbac_meta discovery_auto_dispatch', migrateDiscoveryAutoDispatchFlag],
    ['system reviewer + approval_auto_* switches', migrateApprovalModeSetup],
    ['id_counters match MAX(id) + 1', repairIdCounters],
    ['view_plants for role_000004', migrateUserViewPlants],
    ['system_settings table', migrateSystemSettingsTable],
    ['role_limits table', migrateRoleLimitsTable],
    ['rbac_meta flags -> system_settings', migrateFlagsToSystemSettings],
    ['seed role_limits', migrateSeedRoleLimits],
    ['seed system_settings', migrateSeedSystemSettings]
];

async function migrate() {
    const pool = createPool();
    const conn = await pool.getConnection();
    try {
        console.log('Database :', process.env.DB_NAME);
        console.log('Host     :', process.env.DB_HOST);
        console.log('');

        for (const [label, step] of STEPS) {
            const before = applied.length + skipped.length;
            await step(conn);
            const changed = applied.length + skipped.length > before;
            console.log(`  ${changed ? 'ok  ' : '--  '} ${label}`);
        }

        console.log('');
        for (const line of applied) console.log('  applied :', line);
        for (const line of skipped) console.log('  already :', line);
        console.log('\nMigration complete.');
        return 0;
    } finally {
        conn.release();
        await pool.end();
    }
}

if (require.main === module) {
    migrate()
        .then((code) => process.exit(code))
        .catch((err) => {
            console.error('\nMigration failed:', err.message);
            process.exit(1);
        });
}

module.exports = { migrate, STEPS };