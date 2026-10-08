require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const settings = require('./settings');
const { insertRow, nextKey } = require('./ids.js');
const { logImageReview } = require('../mongoose-schemas/Imgreview.js');
const approvalMode = require('./approval-mode.js');
const { resolveSetting, resolveLimit } = require('./limits.js');

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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Clamps pagination input against settings.pagination. Never throws and never
 * honours an oversized page size; a page past the end simply returns no rows.
 */
function parsePaging(query) {
    const { defaultPageSize, maxPageSize } = settings.pagination;
    const rawPage = parseInt(query.page, 10);
    const rawSize = parseInt(query.pageSize, 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    let pageSize = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : defaultPageSize;
    if (pageSize > maxPageSize) pageSize = maxPageSize;
    return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Escapes LIKE wildcards so a literal % or _ does not match everything. */
function escapeLike(term) {
    return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// Shared normalisation
// ---------------------------------------------------------------------------

/** Trims and collapses internal whitespace to a single space. */
function normalizeName(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim().replace(/\s+/g, ' ');
}

/** scientificName is a machine identifier, so trailing noise is stripped too. */
function normalizeScientificName(value) {
    return normalizeName(value).replace(/\.+$/, '').trim();
}

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * The sentinel for a taxonomy level the botanist did not supply. It has to read
 * as a gap: 'Lamiaceae' reads as a fact nobody will correct, 'Unspecified'
 * does not. kingdom and phylum default to the two values that are right for
 * every plant in this project, so they never carry the sentinel.
 */
const UNSPECIFIED_TAXONOMY = 'Unspecified';

// kingdom and phylum are excluded on purpose: they default correctly, so
// including them in the gap test would match every row and make the filter
// useless.
const TAXONOMY_GAP_LEVELS = ['class', 'order', 'family', 'genus', 'species'];

const TAXONOMY_DEFAULTS = {
    kingdom: 'Plantae',
    phylum: 'Tracheophyta',
    class: UNSPECIFIED_TAXONOMY,
    order: UNSPECIFIED_TAXONOMY,
    family: UNSPECIFIED_TAXONOMY,
    genus: UNSPECIFIED_TAXONOMY,
    species: UNSPECIFIED_TAXONOMY
};

/** Every level is normalised independently; none of them derives from another. */
function buildTaxonomyRow(payload) {
    const pick = (key, ...fallbackKeys) => {
        for (const candidate of [key, ...fallbackKeys]) {
            const cleaned = normalizeName(payload[candidate]);
            if (cleaned) return cleaned;
        }
        return TAXONOMY_DEFAULTS[key];
    };
    return {
        kingdom: pick('kingdom'),
        phylum: pick('phylum'),
        class: pick('class', 'plantClass'),
        order: pick('order'),
        family: pick('family'),
        genus: pick('genus'),
        species: pick('species')
    };
}

// ---------------------------------------------------------------------------
// plant_parts column set
// ---------------------------------------------------------------------------

// The measurements block. Shared by the two detail readers so "is this
// description actually carrying measurements" is decided the same way in both.
const PARTS_FIELDS = [
    'heightMinCm', 'heightMaxCm', 'heightNote',
    'widthMinCm', 'widthMaxCm', 'widthNote',
    'color', 'shape', 'texture'
];

const PARTS_SELECT = PARTS_FIELDS.map((f) => `pp.${f}`).join(', ');

function partsFromRow(r) {
    const populated = {};
    for (const field of PARTS_FIELDS) {
        const value = r[field];
        if (value !== null && value !== undefined && value !== '') populated[field] = value;
    }
    // Every column null means the description simply had no measurements;
    // returning an object of eleven nulls reads as a broken response instead.
    return Object.keys(populated).length > 0 ? populated : null;
}

/** True when any measurement was supplied at all. */
function hasAnyPartValue(parts) {
    return Object.values(parts || {}).some((v) => v !== null && v !== undefined && v !== '');
}

// ---------------------------------------------------------------------------
// Model class list (the scientificName join key)
// ---------------------------------------------------------------------------

const CLASSES_PATH = path.join(__dirname, '..', 'ml', 'model', 'main', 'classes.json');

let classesCache = null;

/**
 * Reads the trained model's class list, or null when it is not available yet.
 *
 * `ml/model/` does not exist until the model artifacts are downloaded, so every
 * caller must treat null as "cannot check", never as "no classes".
 */
function loadModelClasses() {
    if (classesCache !== null) return classesCache;
    try {
        if (!fs.existsSync(CLASSES_PATH)) return null;
        const parsed = JSON.parse(fs.readFileSync(CLASSES_PATH, 'utf8'));
        const values = Array.isArray(parsed) ? parsed : Object.values(parsed);
        classesCache = values
            .map((v) => (typeof v === 'string' ? { scientific: v, common: v } : v))
            .filter((v) => v && v.scientific)
            .map((v) => ({ scientific: v.scientific, common: v.common || v.scientific }));
        if (classesCache.length === 0) return null;
        return classesCache;
    } catch (err) {
        console.error('Could not read classes.json:', err.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Session / auth support
// ---------------------------------------------------------------------------

async function getPermissionsVersion() {
    const [rows] = await mysqlPool.query(
        "SELECT metaValue FROM rbac_meta WHERE metaKey = 'permissions_version'"
    );
    return rows.length > 0 ? parseInt(rows[0].metaValue, 10) : 0;
}

async function loadAccountPermissions(accountId) {
    const [roleRows] = await mysqlPool.query(
        `SELECT r.roleName FROM accounts a
         JOIN roles r ON a.roleId = r.roleId
         WHERE a.accountId = ?`,
        [accountId]
    );
    const roles = roleRows.map((r) => r.roleName);

    const [permRows] = await mysqlPool.query(
        `SELECT DISTINCT p.permissionName FROM permissions p
         JOIN role_permissions rp ON p.permissionId = rp.permissionId
         JOIN roles r ON rp.roleId = r.roleId
         JOIN accounts a ON a.roleId = r.roleId
         WHERE a.accountId = ?`,
        [accountId]
    );
    const permissions = permRows.map((p) => p.permissionName);

    const [userRows] = await mysqlPool.query(
        'SELECT email, username FROM accounts WHERE accountId = ?',
        [accountId]
    );
    const user = userRows[0] || {};

    return { roles, permissions, email: user.email, username: user.username };
}

/** Status plus permissions version, read together on every authenticated request. */
async function getSessionGuard(accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT a.status, m.metaValue
         FROM accounts a
         LEFT JOIN rbac_meta m ON m.metaKey = 'permissions_version'
         WHERE a.accountId = ?`,
        [accountId]
    );
    if (rows.length === 0) return null;
    return {
        status: rows[0].status,
        permissionsVersion: rows[0].metaValue ? parseInt(rows[0].metaValue, 10) : 0
    };
}

async function bumpPermissionsVersion(conn) {
    const target = conn || mysqlPool;
    await target.query(
        "UPDATE rbac_meta SET metaValue = metaValue + 1 WHERE metaKey = 'permissions_version'"
    );
}

/** A role is privileged when it holds access_admin; derived, not hardcoded. */
async function getPrivilegedRoleIds(conn) {
    const target = conn || mysqlPool;
    const [rows] = await target.query(
        `SELECT DISTINCT r.roleId
         FROM role_permissions rp
         JOIN permissions p ON rp.permissionId = p.permissionId
         JOIN roles r ON rp.roleId = r.roleId
         WHERE p.permissionName = 'access_admin'`
    );
    return new Set(rows.map((r) => r.roleId));
}

async function countActiveSuperadmins(conn, excludeAccountId) {
    const target = conn || mysqlPool;
    const [rows] = await target.query(
        `SELECT COUNT(*) AS n FROM accounts a
         JOIN roles r ON a.roleId = r.roleId
         WHERE r.roleName = 'superadmin' AND a.status = 'active' AND a.accountId <> ?`,
        [excludeAccountId || '']
    );
    return rows[0].n;
}

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

// ---------------------------------------------------------------------------
// Admin: users
// ---------------------------------------------------------------------------

/**
 * Paginated, searchable, filterable user list. `counts` is a separate aggregate
 * over every account, because a page of rows cannot produce card totals.
 */
async function listUsers({ search, role, status, page, pageSize }) {
    const paging = parsePaging({ page, pageSize });
    const where = [];
    const params = [];

    if (search) {
        where.push("(a.username LIKE ? ESCAPE '\\\\' OR a.email LIKE ? ESCAPE '\\\\' OR CONCAT(pr.firstName,' ',pr.lastName) LIKE ? ESCAPE '\\\\')");
        const like = `%${escapeLike(search)}%`;
        params.push(like, like, like);
    }
    if (role) {
        // The Administrators card covers every privileged role, so a database
        // holding only the superadmin still shows an administrator there.
        // Derived from access_admin rather than hardcoded.
        if (role === 'admin') {
            where.push(`r.roleId IN (
                SELECT rp.roleId FROM role_permissions rp
                JOIN permissions p ON rp.permissionId = p.permissionId
                WHERE p.permissionName = 'access_admin'
            )`);
        } else {
            where.push('r.roleName = ?');
            params.push(role);
        }
    }
    if (status) {
        where.push('a.status = ?');
        params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await mysqlPool.query(
        `SELECT a.accountId AS id,
                COALESCE(CONCAT(pr.firstName, ' ', pr.lastName), '') AS fullName,
                a.username,
                a.email,
                r.roleName AS role,
                a.status,
                a.createdAt,
                a.lastLoginAt
         FROM accounts a
         JOIN roles r ON a.roleId = r.roleId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         ${whereSql}
         ORDER BY a.createdAt DESC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );

    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total
         FROM accounts a
         JOIN roles r ON a.roleId = r.roleId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         ${whereSql}`,
        params
    );

    const [cardRows] = await mysqlPool.query(
        `SELECT r.roleId, r.roleName, COUNT(*) AS n
         FROM accounts a JOIN roles r ON a.roleId = r.roleId
         GROUP BY r.roleId, r.roleName`
    );
    const privilegedIds = await getPrivilegedRoleIds();
    const counts = { admin: 0, botanist: 0, user: 0, active: 0 };
    for (const row of cardRows) {
        if (privilegedIds.has(row.roleId)) {
            // Matches the Administrators card filter, so the card and the table agree.
            counts.admin += row.n;
        } else if (row.roleName in counts) {
            counts[row.roleName] = row.n;
        }
    }
    const [activeRows] = await mysqlPool.query(
        "SELECT COUNT(*) AS n FROM accounts WHERE status = 'active'"
    );
    counts.active = activeRows[0].n;

    return {
        users: rows.map((r) => ({
            id: r.id,
            name: r.fullName.trim() || r.username,
            username: r.username,
            email: r.email,
            role: r.role,
            status: r.status,
            createdAt: r.createdAt,
            lastLoginAt: r.lastLoginAt
        })),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize,
        counts
    };
}

/**
 * Suspends or reactivates an account. Rejects a change that would leave no
 * active superadmin, and rejects the caller deactivating themselves.
 *
 * The system actor cannot be reactivated. `inactive` is the whole reason it can
 * never authenticate, and the Users page offers a Suspend/Reactivate control on
 * every row — so without this guard one click would turn a machine identity with a
 * throwaway password hash into a loginable account. Suspending it is allowed,
 * because it is already suspended and "make it more capable" is not a direction
 * this project goes in.
 */
async function setAccountStatus(accountId, status, actorAccountId) {
    if (actorAccountId && actorAccountId === accountId) {
        return { error: 'You cannot change your own account status', code: 409 };
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT a.status, r.roleName
             FROM accounts a JOIN roles r ON r.roleId = a.roleId
             WHERE a.accountId = ? FOR UPDATE`,
            [accountId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Account not found', code: 404 };
        }

        if (rows[0].roleName === 'system' && status === 'active') {
            await conn.rollback();
            return {
                error: 'The system account is a machine actor and cannot be activated. ' +
                    'Automatic approvals are authorised by the admin who enabled the mode.',
                code: 409
            };
        }

        if (status === 'inactive' && rows[0].roleName === 'superadmin') {
            const remaining = await countActiveSuperadmins(conn, accountId);
            if (remaining === 0) {
                await conn.rollback();
                return {
                    error: 'The last active superadmin cannot be suspended. Promote another superadmin first.',
                    code: 409
                };
            }
        }

        await conn.query('UPDATE accounts SET status = ? WHERE accountId = ?', [status, accountId]);
        await conn.commit();
        return { accountId, status };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Changes an account's role. Assigning or stripping a privileged role requires
 * admin_promote; otherwise change_role covers user <-> botanist only.
 *
 * The `system` role is outside that range in both directions and is refused here
 * rather than hidden in the UI. The dropdown already omits it, but the endpoint is
 * the gate: assigning `system` would silently strip a real person of every
 * permission, and moving the machine actor onto a human would put a loginable
 * account holding the reviewer value that automatic approvals are written as.
 */
async function changeAccountRole(accountId, newRoleName, actorPermissions, actorAccountId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [targetRows] = await conn.query(
            `SELECT a.roleId, r.roleName
             FROM accounts a JOIN roles r ON r.roleId = a.roleId
             WHERE a.accountId = ? FOR UPDATE`,
            [accountId]
        );
        if (targetRows.length === 0) {
            await conn.rollback();
            return { error: 'Account not found', code: 404 };
        }

        if (newRoleName === 'system' || targetRows[0].roleName === 'system') {
            await conn.rollback();
            return {
                error: 'The system role is a machine actor and is not assignable',
                code: 400
            };
        }


        const [newRoleRows] = await conn.query(
            'SELECT roleId, roleName FROM roles WHERE roleName = ?',
            [newRoleName]
        );
        if (newRoleRows.length === 0) {
            await conn.rollback();
            return { error: 'Unknown role', code: 400 };
        }

        const privileged = await getPrivilegedRoleIds(conn);
        const currentIsPrivileged = privileged.has(targetRows[0].roleId);
        const newIsPrivileged = privileged.has(newRoleRows[0].roleId);
        const actorCanPromote = (actorPermissions || []).includes('admin_promote');

        if (currentIsPrivileged || newIsPrivileged) {
            if (!actorCanPromote) {
                await conn.rollback();
                return { error: 'admin_promote permission is required for this role change', code: 403 };
            }
        } else if (!(actorPermissions || []).includes('change_role')) {
            await conn.rollback();
            return { error: 'change_role permission is required', code: 403 };
        }

        if (targetRows[0].roleName === 'superadmin' && newRoleName !== 'superadmin') {
            const remaining = await countActiveSuperadmins(conn, accountId);
            if (remaining === 0) {
                await conn.rollback();
                return {
                    error: 'The last active superadmin cannot be demoted. Promote another superadmin first.',
                    code: 409
                };
            }
        }
        if (actorAccountId && actorAccountId === accountId && newRoleName !== targetRows[0].roleName) {
            await conn.rollback();
            return { error: 'You cannot change your own role', code: 409 };
        }

        await conn.query('UPDATE accounts SET roleId = ? WHERE accountId = ?', [
            newRoleRows[0].roleId,
            accountId
        ]);
        await bumpPermissionsVersion(conn);
        await conn.commit();
        return { accountId, role: newRoleName };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Admin: requests (the unified review queue)
// ---------------------------------------------------------------------------

async function listPendingRoleRequests() {
    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.accountId, ar.requestedRole, ar.status, ar.createdAt,
                ar.note, a.email, a.username,
                pr.firstName, pr.lastName,
                c.certificateId, c.originalFilename AS certificateFilename,
                c.mimeType AS certificateMimeType, c.size AS certificateSize
         FROM approval_requests ar
         JOIN accounts a ON ar.accountId = a.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         LEFT JOIN certificates c ON c.certificateId = (
             SELECT c2.certificateId FROM certificates c2
             WHERE c2.accountId = ar.accountId
             ORDER BY c2.uploadedAt DESC LIMIT 1
         )
         WHERE ar.status = 'pending' AND ar.requestType = 'role_permission'
         ORDER BY ar.createdAt ASC`
    );
    return rows.map((r) => ({
        requestId: r.requestId,
        accountId: r.accountId,
        requestedRole: r.requestedRole,
        status: r.status,
        createdAt: r.createdAt,
        requestedAt: r.createdAt,
        note: r.note,
        email: r.email,
        username: r.username,
        fullName: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.username,
        hasCertificate: Boolean(r.certificateId),
        certificate: r.certificateId
            ? {
                certificateId: r.certificateId,
                url: `/admin/certificates/${encodeURIComponent(r.accountId)}`,
                filename: r.certificateFilename,
                mimeType: r.certificateMimeType,
                size: r.certificateSize
            }
            : null
    }));
}

/**
 * Plant-facing view of the queue. A plant_addition draft lives in `payload`, so
 * its name and type are read from there; a contribution points at targetPlantId.
 */
async function listPlantRequests({ requestType, page, pageSize }) {
    const paging = parsePaging({ page, pageSize });
    const where = ["ar.status = 'pending'", "ar.requestType IN ('plant_addition','plant_contribution')"];
    const params = [];

    if (requestType) {
        where.push('ar.requestType = ?');
        params.push(requestType);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.requestType, ar.targetPlantId, ar.payload, ar.createdAt, ar.note,
                ar.approvalMode,
                a.accountId AS submitterId, a.username AS submitterName,
                pr.firstName AS submitterFirstName, pr.lastName AS submitterLastName,
                p.commonName AS targetCommonName, t.typeName AS targetType, t.label AS targetTypeLabel
         FROM approval_requests ar
         JOIN accounts a ON ar.accountId = a.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         LEFT JOIN plants p ON ar.targetPlantId = p.plantId
         LEFT JOIN plant_types t ON p.typeId = t.typeId
         ${whereSql}
         ORDER BY ar.createdAt ASC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );

    // Must carry the same alias as the row query: whereSql references ar.*, so a
    // count without the alias cannot resolve it.
    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total FROM approval_requests ar ${whereSql}`,
        params
    );

    return {
        requests: rows.map((r) => {
            let payload = {};
            try {
                payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
            } catch (err) {
                payload = {};
            }
            const isAddition = r.requestType === 'plant_addition';
            const fullName = [r.submitterFirstName, r.submitterLastName].filter(Boolean).join(' ');
            const imageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
            return {
                id: r.requestId,
                requestType: r.requestType,
                plantName: isAddition ? (payload.commonName || '(unnamed draft)') : r.targetCommonName,
                type: isAddition ? (payload.typeName || null) : r.targetType,
                typeLabel: isAddition ? (payload.typeLabel || null) : r.targetTypeLabel,
                targetPlantId: r.targetPlantId,
                submittedBy: r.submitterId,
                // Full name when the profile has one, username as the fallback.
                submittedByName: fullName || r.submitterName,
                requestedAt: r.createdAt,
                note: r.note,
                // Always present so the row shape is stable, and read from SQL
                // rather than from Mongo: logImageReview swallows its own errors,
                // so a failed audit write must not be able to make a decided
                // request look undecided. A pending row is 'manual' by definition —
                // nothing has decided it yet.
                approvalMode: r.approvalMode || 'manual',
                hasDescription: Boolean(payload.uses || payload.benefits || payload.harmful || payload.parts),
                images: imageIds.map((imageId) => ({
                    imageId,
                    url: `/admin/api/plant-images/${encodeURIComponent(imageId)}`
                })),
                payload
            };
        }),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize
    };
}

/** Everything the admin needs to review one plant request, including files. */
async function getRequestDetail(requestId) {
    const [rows] = await mysqlPool.query(
        `SELECT ar.*, a.username AS submitterName, a.email AS submitterEmail
         FROM approval_requests ar
         JOIN accounts a ON ar.accountId = a.accountId
         WHERE ar.requestId = ?`,
        [requestId]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    let payload = {};
    try {
        payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
    } catch (err) {
        payload = {};
    }

    const imageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
    let images = [];
    if (imageIds.length > 0) {
        const placeholders = imageIds.map(() => '?').join(',');
        const [imgRows] = await mysqlPool.query(
            `SELECT imageId, originalFilename, mimeType, size, status
             FROM plant_images WHERE imageId IN (${placeholders})`,
            imageIds
        );
        images = imgRows;
    }

    return {
        requestId: row.requestId,
        requestType: row.requestType,
        requestedRole: row.requestedRole,
        targetPlantId: row.targetPlantId,
        status: row.status,
        note: row.note,
        createdAt: row.createdAt,
        reviewedAt: row.reviewedAt,
        submittedBy: row.accountId,
        submittedByName: row.submitterName,
        submittedByEmail: row.submitterEmail,
        payload,
        images
    };
}

async function claimPendingRequest(conn, requestId) {
    const [rows] = await conn.query(
        'SELECT * FROM approval_requests WHERE requestId = ? AND status = ? FOR UPDATE',
        [requestId, 'pending']
    );
    return rows[0] || null;
}

/**
 * Settles a request and records HOW it was settled.
 *
 * `approvalMode` is written on every approve and every deny, under either mode,
 * because the column is the queue's only source of truth about that: the audit
 * collection is Mongo, and logImageReview swallows its own errors, so a logging
 * outage would otherwise leave a real decision with no record of it. The queue
 * reads this column, never Mongo.
 *
 * It is DERIVED from the reviewer rather than passed in, so it cannot disagree
 * with reviewedBy: there is no second value to set and no call site that can
 * supply the wrong one. That is what makes "a manual approve while the type is in
 * auto mode still records approvalMode = 'manual'" true by construction.
 */
async function finishRequest(conn, requestId, status, reviewerId, note) {
    const audit = approvalMode.auditContextFor(reviewerId);
    await conn.query(
        'UPDATE approval_requests SET status = ?, reviewedBy = ?, reviewedAt = NOW(), note = ?, approvalMode = ? WHERE requestId = ?',
        [status, reviewerId, note || null, audit.approvalMode, requestId]
    );
    return audit;
}

/**
 * The shared body of a role_permission decision.
 *
 * Lives here rather than in routes/role-requests.js because there are now two
 * callers — an admin clicking Approve, and the automatic pass — and two copies of
 * a privilege grant is exactly how they drift. The route's own inline transaction
 * was the second copy; this is the one, and the route now only maps HTTP onto it.
 *
 * Automatic approval of a role request is deliberately permitted and is NOT one of
 * the two publishing switches: it grants record_plant, and the certificate an
 * admin would have inspected is already required at registration. It changes a
 * permission, so it bumps permissions_version exactly as a manual approval does —
 * otherwise the account's live session would keep its old permission set until it
 * happened to log in again.
 */
async function decideRoleRequest(requestId, reviewerId, { approve, note, deleteCertificate } = {}) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // claimPendingRequest, not a bare SELECT: the same FOR UPDATE guard the
        // plant approvers take, so two callers cannot both grant the role.
        const request = await claimPendingRequest(conn, requestId);
        if (!request) {
            await conn.rollback();
            return { error: 'Pending role request not found or already resolved', code: 409 };
        }
        if (request.requestType !== 'role_permission') {
            await conn.rollback();
            return { error: 'Not a role request', code: 400 };
        }

        const accountId = request.accountId;
        const requestedRole = request.requestedRole;

        if (approve) {
            const [roleRows] = await conn.query('SELECT roleId FROM roles WHERE roleName = ?', [requestedRole]);
            if (roleRows.length === 0) {
                await conn.rollback();
                return { error: 'Invalid role', code: 400 };
            }
            await conn.query('UPDATE accounts SET roleId = ? WHERE accountId = ?', [roleRows[0].roleId, accountId]);
            await bumpPermissionsVersion(conn);
        }

        const audit = await finishRequest(
            conn,
            requestId,
            approve ? 'approved' : 'denied',
            reviewerId,
            note
        );

        // The certificate is only destroyed on an explicit denial, and only when
        // the caller asked for it — an approval must not lose the evidence.
        if (!approve && deleteCertificate) {
            const [certs] = await conn.query(
                'SELECT certificateId FROM certificates WHERE accountId = ?',
                [accountId]
            );
            for (const cert of certs) {
                await deleteCertificate(conn, cert.certificateId);
            }
        }

        await conn.commit();

        await logImageReview({
            requestId,
            requestType: request.requestType,
            imageId: null,
            plantId: null,
            accountId,
            decision: approve
                ? (audit.approvalMode === 'auto' ? 'auto_approved' : 'approved')
                : 'rejected',
            approvalMode: audit.approvalMode,
            decisionSource: audit.decisionSource,
            ruleVersion: audit.ruleVersion,
            reason: audit.reason,
            reviewedBy: reviewerId,
            note: note || ''
        });

        return {
            requestId,
            accountId,
            approvalMode: audit.approvalMode,
            ...(approve ? { newRole: requestedRole } : {})
        };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Admin: plants
// ---------------------------------------------------------------------------

const CONTRIBUTOR_LIST_LENGTH = 120;

/**
 * Paginated plant inventory. Recorded By and Reviewed By are GROUP_CONCATs of
 * plant_contributors, truncated so one busy plant cannot blow up the payload.
 *
 * Also reports which taxonomy levels are still Unspecified, because that is the
 * whole value of the left join on taxonomy: nothing else in the project reads
 * those columns, so a gap would otherwise be invisible.
 */
async function listPlants({ search, type, taxonomyGap, page, pageSize }) {
    const paging = parsePaging({ page, pageSize });
    const where = [];
    const params = [];

    if (search) {
        where.push("(p.commonName LIKE ? ESCAPE '\\\\' OR p.scientificName LIKE ? ESCAPE '\\\\')");
        const like = `%${escapeLike(search)}%`;
        params.push(like, like);
    }
    if (type) {
        where.push('t.typeName = ?');
        params.push(type);
    }

    const GAP_PREDICATE = TAXONOMY_GAP_LEVELS
        .map((level) => `tx.\`${level}\` = '${UNSPECIFIED_TAXONOMY}'`)
        .join(' OR ');
    if (taxonomyGap) where.push(`(${GAP_PREDICATE})`);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const gapSelect = TAXONOMY_GAP_LEVELS.map((level) => `tx.\`${level}\` AS tax_${level}`).join(', ');

    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.quantity, p.createdAt,
                t.typeName, t.label AS typeLabel, t.icon AS typeIcon, t.badgeClass AS typeBadgeClass,
                ${gapSelect},
                (SELECT COUNT(*) FROM plant_images i WHERE i.plantId = p.plantId AND i.status = 'approved') AS imageCount,
                (SELECT COUNT(*) FROM plant_images i WHERE i.plantId = p.plantId AND i.status = 'pending') AS pendingImageCount,
                (SELECT COUNT(*) FROM plant_description d WHERE d.plantId = p.plantId AND d.status = 'approved') AS descriptionCount
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         LEFT JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
         ${whereSql}
         ORDER BY p.createdAt DESC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );

    // Must carry the same FROM as the row query above: whereSql can reference
    // the taxonomy alias when ?taxonomyGap=1 is set, and a count without the join
    // cannot resolve it.
    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         LEFT JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
         ${whereSql}`,
        params
    );

    // Read from the same response rather than a second endpoint: the dashboard
    // card and this table can then never disagree.
    const [gapCountRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         LEFT JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
         WHERE (${GAP_PREDICATE})`
    );

    const plants = [];
    for (const row of rows) {
        plants.push({
            id: row.plantId,
            name: row.commonName,
            scientificName: row.scientificName,
            type: row.typeName,
            typeLabel: row.typeLabel,
            typeIcon: row.typeIcon,
            typeBadgeClass: row.typeBadgeClass,
            quantity: row.quantity,
            dateUploaded: row.createdAt,
            imageCount: row.imageCount,
            pendingImageCount: row.pendingImageCount,
            descriptionCount: row.descriptionCount,
            missingTaxonomyLevels: TAXONOMY_GAP_LEVELS.filter(
                (level) => row[`tax_${level}`] === UNSPECIFIED_TAXONOMY
            ),
            ...(await getContributorSummary(row.plantId)),
            ...(await getPlantDetailSummary(row.plantId))
        });
    }

    return {
        plants,
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize,
        taxonomyGapTotal: gapCountRows[0].total,
        taxonomyGapLevels: TAXONOMY_GAP_LEVELS
    };
}

/**
 * Who is named on a plant, and for what.
 *
 * Three roles now reach this: 'contributor' renders as Recorded By, 'reviewer'
 * as Reviewed By, and 'reporter' as Reported By — the account that filed the
 * discovery report which produced the species. Reported By is CREDIT, not
 * authorship: a `user` never appears as a contributor and never authors a
 * plant_description.
 */
/**
 * The contributor labels a plant page renders.
 *
 * The label is the profile name when there is one, and the username otherwise.
 * `CONCAT_WS` rather than `CONCAT` because `CONCAT` with a NULL lastName yields
 * NULL for the WHOLE string, which silently discards a first name the account did
 * give — and the machine actor is exactly that case (firstName 'System', lastName
 * NULL), which would have left "Reviewed By" empty on every automatically approved
 * plant. TRIM because CONCAT_WS of a first name and a NULL still leaves nothing to
 * trim, but a profile with an empty-string last name would.
 *
 * The COALESCE back to the username is NOT new and must not be dropped: many
 * accounts have no profile row at all, and without the fallback every one of them
 * would vanish from Recorded By / Reviewed By / Reported By.
 */
async function getContributorSummary(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT pc.role, GROUP_CONCAT(DISTINCT COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.firstName, p.lastName)), ''), a.username)
                    ORDER BY pc.createdAt SEPARATOR ', ') AS names
         FROM plant_contributors pc
         JOIN accounts a ON pc.accountId = a.accountId
         LEFT JOIN profiles p ON p.accountId = a.accountId
         WHERE pc.plantId = ?
         GROUP BY pc.role`,
        [plantId]
    );
    const summary = { recordedBy: [], reviewedBy: [], reportedBy: [] };
    for (const row of rows) {
        const names = row.names || '';
        if (!names) continue;
        const parts = names.split(', ');
        const shown = parts.slice(0, 3).join(', ');
        const overflow = parts.length > 3 ? ` +${parts.length - 3} more` : '';
        const label = (shown + overflow).slice(0, CONTRIBUTOR_LIST_LENGTH);
        if (row.role === 'contributor') summary.recordedBy.push(label);
        if (row.role === 'reviewer') summary.reviewedBy.push(label);
        if (row.role === 'reporter') summary.reportedBy.push(label);
    }
    return {
        recordedBy: summary.recordedBy.join('; '),
        reviewedBy: summary.reviewedBy.join('; '),
        reportedBy: summary.reportedBy.join('; ')
    };
}

async function getPlantDetailSummary(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT d.uses, d.benefits, d.harmful,
                ${PARTS_SELECT}
         FROM plant_description d
         -- LEFT JOIN, not INNER: partsId is nullable, so a description recorded
         -- without measurements is still a description.
         LEFT JOIN plant_parts pp ON d.partsId = pp.partId
         WHERE d.plantId = ? AND d.status = 'approved' AND d.isPrimary = TRUE
         LIMIT 1`,
        [plantId]
    );
    if (rows.length === 0) return { parts: null, description: null };
    const r = rows[0];
    return {
        parts: partsFromRow(r),
        description: { uses: r.uses, benefits: r.benefits, harmful: r.harmful }
    };
}

async function listPlantImages(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT i.imageId, i.originalFilename, i.mimeType, i.size, i.status, i.isPrimary, i.uploadedAt,
                a.username AS uploadedByName
         FROM plant_images i
         JOIN accounts a ON i.accountId = a.accountId
         WHERE i.plantId = ?
         ORDER BY i.isPrimary DESC, i.uploadedAt ASC`,
        [plantId]
    );
    return rows.map((r) => ({
        imageId: r.imageId,
        originalFilename: r.originalFilename,
        mimeType: r.mimeType,
        size: r.size,
        status: r.status,
        isPrimary: Boolean(r.isPrimary),
        uploadedAt: r.uploadedAt,
        uploadedByName: r.uploadedByName
    }));
}

/** Public serving: approved rows only. */
async function getImageForServing(imageId) {
    const [rows] = await mysqlPool.query(
        `SELECT imageId, plantId, originalFilename, storedPath, mimeType
         FROM plant_images WHERE imageId = ? AND status = 'approved'`,
        [imageId]
    );
    return rows[0] || null;
}

/**
 * Review-time serving: any status, because an admin has to see the photos they
 * are being asked to approve. Never reachable from a public route.
 */
async function getImageForReview(imageId) {
    const [rows] = await mysqlPool.query(
        `SELECT imageId, plantId, originalFilename, storedPath, mimeType, status
         FROM plant_images WHERE imageId = ?`,
        [imageId]
    );
    return rows[0] || null;
}

/**
 * Owner serving: the submitter sees their own photo whatever the status, because
 * the only feedback a botanist gets for a rejected upload is the per-request
 * note. The accountId predicate is the entire privacy property of the owner
 * route — written in the style of getImageForReview (which deliberately omits
 * it) this would expose every pending photo to its uploader's rivals. Never
 * public, never cached.
 */
async function getImageForOwner(imageId, accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT imageId, plantId, accountId, originalFilename, storedPath, mimeType, size, status
         FROM plant_images WHERE imageId = ? AND accountId = ?`,
        [imageId, accountId]
    );
    return rows[0] || null;
}

async function getPlantExists(plantId) {
    const [rows] = await mysqlPool.query('SELECT plantId FROM plants WHERE plantId = ?', [plantId]);
    return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Approval: promoting a request into real content
// ---------------------------------------------------------------------------

async function addContributorRow(conn, plantId, accountId, role) {
    await conn.query(
        'INSERT IGNORE INTO plant_contributors (plantId, accountId, role) VALUES (?, ?, ?)',
        [plantId, accountId, role]
    );
}

/** First approved description / image for a plant becomes its primary. */
async function ensurePrimaryContent(conn, plantId) {
    await conn.query(
        'UPDATE plant_description SET isPrimary = FALSE WHERE plantId = ? AND status = ? AND isPrimary = TRUE',
        [plantId, 'approved']
    );
    await conn.query(
        `UPDATE plant_description SET isPrimary = TRUE
         WHERE descriptionId = (
             SELECT d2.descriptionId FROM (
                 SELECT descriptionId FROM plant_description
                 WHERE plantId = ? AND status = 'approved'
                 ORDER BY createdAt ASC LIMIT 1
             ) d2
         )`,
        [plantId]
    );
    await conn.query(
        'UPDATE plant_images SET isPrimary = FALSE WHERE plantId = ? AND status = ? AND isPrimary = TRUE',
        [plantId, 'approved']
    );
    await conn.query(
        `UPDATE plant_images SET isPrimary = TRUE
         WHERE imageId = (
             SELECT i2.imageId FROM (
                 SELECT imageId FROM plant_images
                 WHERE plantId = ? AND status = 'approved'
                 ORDER BY uploadedAt ASC LIMIT 1
             ) i2
         )`,
        [plantId]
    );
}

function parsePayload(payload) {
    if (!payload) return {};
    if (typeof payload === 'string') {
        try {
            return JSON.parse(payload);
        } catch (err) {
            return {};
        }
    }
    return payload;
}

/**
 * Approves a plant_addition or plant_contribution.
 *
 * A plant_addition whose scientificName already exists is not an error: its
 * parts, description and images attach to the existing plant instead, and the
 * submitter is recorded as a contributor on it.
 *
 * A plant_discovery is NEVER approvable, by anyone, and the guard is explicit
 * rather than the accidental 400 the fall-through produced. plantId is only
 * assigned inside the plant_addition branch or from targetPlantId, so a report
 * reached `Request has no resolvable plant` — a message blaming the data for a
 * design decision. A report carries no content of its own to approve; its
 * approval IS the approval of the record it produced.
 */
async function approvePlantRequest(requestId, reviewerId, note) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const request = await claimPendingRequest(conn, requestId);
        if (!request) {
            await conn.rollback();
            return { error: 'Request is not pending or does not exist', code: 409 };
        }

        if (request.requestType === DISCOVERY_TYPE) {
            await conn.rollback();
            return {
                error: 'Discovery reports are resolved by approving the record they produced',
                code: 400
            };
        }

        const payload = parsePayload(request.payload);
        const submitterId = request.accountId;
        // Resolved ONCE, before any write, because this function settles up to two
        // rows: the record itself and the discovery report it closes. Both have to
        // carry the same approvalMode, and deriving it at each call site is how
        // they would come to disagree.
        const audit = approvalMode.auditContextFor(reviewerId);
        let plantId = request.targetPlantId;
        let converted = false;
        let noteText = note || null;

        // Names are normalised before anything reads them, so the value that is
        // validated, the value that is looked up and the value that is stored
        // are one and the same string.
        const scientificName = normalizeScientificName(payload.scientificName);
        const commonName = normalizeName(payload.commonName);

        if (request.requestType === 'plant_addition') {
            const [existing] = await conn.query(
                'SELECT plantId FROM plants WHERE scientificName = ? FOR UPDATE',
                [scientificName]
            );
            if (existing.length > 0) {
                plantId = existing[0].plantId;
                converted = true;
                noteText = note
                    ? `${note}\n\n[system] This species already existed as ${plantId}; the submission was attached to it.`
                    : `[system] This species already existed as ${plantId}; the submission was attached to it.`;
            } else {
                const taxonomy = buildTaxonomyRow(payload);
                const taxonomyId = await insertRow(
                    conn,
                    'taxonomy',
                    ['kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'],
                    [
                        taxonomy.kingdom,
                        taxonomy.phylum,
                        taxonomy.class,
                        taxonomy.order,
                        taxonomy.family,
                        taxonomy.genus,
                        taxonomy.species
                    ]
                );
                plantId = await insertRow(
                    conn,
                    'plants',
                    ['taxonomyId', 'typeId', 'commonName', 'scientificName', 'quantity'],
                    [taxonomyId, payload.typeId, commonName, scientificName, payload.quantity ?? null]
                );
            }
        }

        if (!plantId) {
            await conn.rollback();
            return { error: 'Request has no resolvable plant', code: 400 };
        }

        // Write the resolved plant back, so a brand-new-species submission is
        // reachable from My Submissions. A contribution already carries it.
        await conn.query(
            'UPDATE approval_requests SET targetPlantId = ? WHERE requestId = ?',
            [plantId, requestId]
        );

        // Parts: either the draft's measurements or a contribution's upload.
        const parts = payload.parts || {};
        const hasParts = hasAnyPartValue(parts);
        let partsId = payload.partsId || null;
        if (!partsId && hasParts) {
            partsId = await insertRow(
                conn,
                'plant_parts',
                [
                    'plantId', 'accountId', 'heightMinCm', 'heightMaxCm', 'heightNote',
                    'widthMinCm', 'widthMaxCm', 'widthNote', 'color', 'shape', 'texture', 'status'
                ],
                [
                    plantId, submitterId,
                    parts.heightMinCm ?? null, parts.heightMaxCm ?? null, parts.heightNote ?? null,
                    parts.widthMinCm ?? null, parts.widthMaxCm ?? null, parts.widthNote ?? null,
                    parts.color ?? null, parts.shape ?? null, parts.texture ?? null,
                    'approved'
                ]
            );
        }

        // Description: a draft carries the text inline, a contribution too.
        // hasContent, not hasDescription && partsId: the description row is the
        // thing the public page renders and the thing public visibility requires,
        // so a measurements-only contribution has to produce one too (with a null
        // partsId). An image-only contribution correctly produces none.
        const uses = normalizeName(payload.uses) || null;
        const benefits = normalizeName(payload.benefits) || null;
        const harmful = normalizeName(payload.harmful) || null;
        const hasDescription = Boolean(uses || benefits || harmful);
        const hasContent = hasDescription || hasParts;
        if (hasContent) {
            await insertRow(
                conn,
                'plant_description',
                ['plantId', 'accountId', 'partsId', 'uses', 'benefits', 'harmful', 'status', 'isPrimary', 'reviewedBy', 'reviewedAt'],
                [plantId, submitterId, partsId, uses, benefits, harmful,
                 'approved', false, reviewerId, new Date()]
            );
        }

        // Images uploaded with the request become approved.
        const imageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
        for (const imageId of imageIds) {
            await conn.query(
                'UPDATE plant_images SET status = ?, reviewedBy = ?, reviewedAt = NOW() WHERE imageId = ? AND plantId = ?',
                ['approved', reviewerId, imageId, plantId]
            );
        }

        await addContributorRow(conn, plantId, submitterId, 'contributor');
        await addContributorRow(conn, plantId, reviewerId, 'reviewer');

        //  the report that produced this record is closed here, and
        // the person who FILED it is credited on the plant.
        //
        // This is not auto-approval and does not contradict document 3: an admin
        // made this decision by hand, and the report's only purpose was to produce
        // this record. A discovery report does not have two independent lifecycles,
        // so once its record lands "pending report" stops being true — and leaving
        // it pending is a queue entry that looks like outstanding work for a
        // species already in the library.
        //
        // targetPlantId is set at the same time  so the admin queue, the
        // botanist queue and the reporter's view all reach the plant in ONE hop
        // instead of two via recordRequestId. Note it carries ON DELETE CASCADE,
        // so deleting that plant later silently deletes the report too — pre-existing
        // behaviour for every request type, and why a report is not durable evidence.
        let discoveryClosed = null;
        if (payload.discoveryRequestId) {
            const [reportRows] = await conn.query(
                'SELECT accountId, note FROM approval_requests WHERE requestId = ? AND requestType = ?',
                [payload.discoveryRequestId, DISCOVERY_TYPE]
            );
            if (reportRows.length > 0) {
                const reporterId = reportRows[0].accountId;
                const systemNote =
                    `[system] Resolved by approving record ${requestId}, which added ${plantId}.`;
                await conn.query(
                    `UPDATE approval_requests
                     SET status = 'approved', targetPlantId = ?, reviewedBy = ?, reviewedAt = NOW(),
                         approvalMode = ?, note = CONCAT(COALESCE(note, ''), ?)
                     WHERE requestId = ?`,
                    [plantId, reviewerId, audit.approvalMode, systemNote, payload.discoveryRequestId]
                );
                // Credit, NOT authorship. The 'contributor' row and
                // plant_description.accountId stay with the botanist who wrote the
                // description; a 'user' is only ever a reporter.
                await addContributorRow(conn, plantId, reporterId, 'reporter');
                discoveryClosed = { requestId: payload.discoveryRequestId, reporterId, plantId };
            }
        }

        await ensurePrimaryContent(conn, plantId);
        await finishRequest(conn, requestId, 'approved', reviewerId, noteText);

        await conn.commit();

        // After the commit: a logging failure must never roll back a review.
        // One record per decision, not per image, so a text-only submission
        // still leaves an audit trail.
        await logImageReview({
            requestId,
            requestType: request.requestType,
            imageId: null,
            plantId,
            accountId: submitterId,
            // 'auto_approved' rather than 'approved' + a flag: "which decisions did
            // no human look at?" has to be a query, not an inference.
            decision: audit.approvalMode === 'auto' ? 'auto_approved' : 'approved',
            approvalMode: audit.approvalMode,
            decisionSource: audit.decisionSource,
            ruleVersion: audit.ruleVersion,
            reason: audit.reason,
            reviewedBy: reviewerId,
            note: noteText || ''
        });

        return { requestId, plantId, converted, discoveryClosed, approvalMode: audit.approvalMode };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Denies a request. A contribution only rejects the rows named in its own
 * payload, so a later contribution to the same plant is untouched.
 *
 * `kind` is the two-kinds split  and defaults to 'revise', which is what
 * every existing Deny click sends — it must not silently become the harsher
 * option.
 *
 *   revise  the record is denied and the linked discovery report STAYS pending and
 *           returns to the botanist, who still holds the claim and can fix a typo
 *           or swap a photo and resubmit immediately.
 *   reject  the species itself is refused: the record AND the report are denied
 *           with the same note, so nothing is left open.
 *
 * The report write is in the SAME transaction as the denial — a report closed by a
 * half-applied rejection would vanish from the queue with no decision recorded.
 *
 * disqualifiedBy is left alone by both kinds: that column is a BOTANIST's "not a
 * plant" verdict carrying a reason enum, and borrowing it for an admin's action
 * would misattribute the finding. The claim is likewise not cleared —
 * `status != 'pending'` already ends its life for the cap, and keeping it records
 * who was working on it.
 */
async function denyPlantRequest(requestId, reviewerId, note, kind = 'revise') {
    if (!DENIAL_KINDS.includes(kind)) {
        return { error: `kind must be one of: ${DENIAL_KINDS.join(', ')}`, code: 400 };
    }
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const request = await claimPendingRequest(conn, requestId);
        if (!request) {
            await conn.rollback();
            return { error: 'Request is not pending or does not exist', code: 409 };
        }

        const payload = parsePayload(request.payload);
        const audit = approvalMode.auditContextFor(reviewerId);
        const imageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
        for (const imageId of imageIds) {
            await conn.query(
                'UPDATE plant_images SET status = ?, reviewedBy = ?, reviewedAt = NOW() WHERE imageId = ?',
                ['rejected', reviewerId, imageId]
            );
        }
        if (request.targetPlantId) {
            await conn.query(
                `UPDATE plant_description SET status = 'rejected', reviewedBy = ?, reviewedAt = NOW()
                 WHERE accountId = ? AND plantId = ? AND status = 'pending'`,
                [reviewerId, request.accountId, request.targetPlantId]
            );
            await conn.query(
                `UPDATE plant_parts SET status = 'rejected'
                 WHERE accountId = ? AND plantId = ? AND status = 'pending'`,
                [request.accountId, request.targetPlantId]
            );
        }

        // Only a `reject` closes the report, and only when there IS one. The admin
        // UI offers the choice only in that case, so nobody picks "reject the
        // species" on a request where it would silently do nothing.
        let discoveryDenied = null;
        if (kind === 'reject' && payload.discoveryRequestId) {
            const [result] = await conn.query(
                `UPDATE approval_requests
                 SET status = 'denied', reviewedBy = ?, reviewedAt = NOW(), approvalMode = ?,
                     note = COALESCE(NULLIF(?, ''), note)
                 WHERE requestId = ? AND requestType = ? AND status = 'pending'`,
                [reviewerId, audit.approvalMode, note || '', payload.discoveryRequestId, DISCOVERY_TYPE]
            );
            if (result.affectedRows > 0) discoveryDenied = payload.discoveryRequestId;
        }

        await finishRequest(conn, requestId, 'denied', reviewerId, note);
        await conn.commit();

        // After the commit, for the same reason as on approval.
        await logImageReview({
            requestId,
            requestType: request.requestType,
            imageId: null,
            plantId: request.targetPlantId || null,
            accountId: request.accountId,
            // Auto mode never denies anything, so there is no auto_rejected. If a
            // future rule set does deny, it gets its own decision value then, and
            // the audit stays queryable by "nobody looked at this".
            decision: 'rejected',
            approvalMode: audit.approvalMode,
            decisionSource: audit.decisionSource,
            ruleVersion: audit.ruleVersion,
            reason: audit.reason,
            reviewedBy: reviewerId,
            note: note || ''
        });

        return { requestId, kind, discoveryDenied, approvalMode: audit.approvalMode };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Automatic approval
// ---------------------------------------------------------------------------

/**
 * Has this submitter ever had a request of this type DECIDED?
 *
 * The first-submission rail: a human must see each submitter once, because a
 * submitter who has never been reviewed may be uploading anything at all. After
 * that, an equivalent submission may pass unattended.
 *
 * Reads MySQL, not Mongo, and that is the load-bearing choice. `imgreviews`
 * carries the same fact (requestType + accountId + decision, one row per decision
 * rather than per image) and is what an auditor queries afterwards — but
 * logImageReview swallows its own errors, so a Mongo outage would make every
 * submitter look brand new, permanently, and silently disable the rail for the
 * whole site. MySQL is in the same transaction as the decision and cannot fail
 * open: the row that was just written is the row this reads.
 *
 * PER TYPE rather than per account. "A human must see each submitter once" is a
 * statement about the person, but the thing being reviewed is a kind of request:
 * someone whose first description was checked by hand has had their botanical
 * text read, and an unseen photo in a later contribution is a different question.
 */
async function hasPriorSubmissionDecision(conn, accountId, requestType) {
    const [rows] = await conn.query(
        `SELECT COUNT(*) AS n FROM approval_requests
         WHERE accountId = ? AND requestType = ? AND status IN ('approved', 'denied')`,
        [accountId, requestType]
    );
    return Number(rows[0].n) > 0;
}

/**
 * Decides whether `request` should be resolved automatically. A DECISION, never a
 * write — see the note on processNewRequest for why.
 *
 * Runs INSIDE the caller's transaction, on a row that caller already took with
 * claimPendingRequest, so the switch read and the pending claim are one consistent
 * snapshot and two concurrent passes cannot both see 'pending'.
 *
 * The mode is re-read here rather than passed in or cached. A cached value is a
 * value that was true when the process started, which is precisely how "I turned
 * auto approval off and it kept approving" happens; a value read by the route is a
 * value that can be stale by the time the write lands.
 *
 * The three rails, in order, each permanent and none of them switchable:
 *
 *   1. A discovery report is outside auto mode ENTIRELY — never approved, never
 *      denied. It carries no species of its own; its approval is the approval of
 *      the record it produced, and that record is an ordinary plant_addition or
 *      plant_contribution covered by rail 2 and rail 3 below. Nothing is lost: the
 *      report still closes when its record is decided. A fourth switch for reports
 *      would imply the queue can clear itself for species nobody ever recorded.
 *
 *   2. A submitter's first submission of this type is always reviewed by hand.
 *
 *   3. Nothing is ever DENIED automatically. A denial is a judgement that the
 *      contribution is wrong, and this rule set has nothing to judge it with. The
 *      existing approvePlantRequest / denyPlantRequest bodies therefore run
 *      unchanged: duplicate-species conversion, ensurePrimaryContent and the
 *      hasContent gate all still apply, which is the point of delegating rather
 *      than reimplementing.
 */
async function maybeAutoResolve(conn, request, { triggeredBy = 'submission' } = {}) {
    if (request.requestType === DISCOVERY_TYPE) {
        return {
            decided: false,
            reason: 'discovery reports are outside auto mode',
            rail: 'discovery'
        };
    }

    if (!approvalMode.APPROVAL_AUTO_KEYS[request.requestType]) {
        return { decided: false, reason: `${request.requestType} has no approval switch`, rail: 'no-switch' };
    }

    if (!(await approvalMode.isAutoApproval(conn, request.requestType))) {
        return {
            decided: false,
            reason: `${request.requestType} approval mode is manual`,
            rail: 'mode-off'
        };
    }

    if (!(await hasPriorSubmissionDecision(conn, request.accountId, request.requestType))) {
        return {
            decided: false,
            reason: "a submitter's first submission is always reviewed by hand",
            rail: 'first-submission'
        };
    }

    // The SYSTEM account, never the triggering admin's id and never null. The
    // trigger is *why* the decision happened; the system account is *who* made it,
    // and collapsing the two would make "who approved this?" answerable only as
    // "whoever happened to be logged in".
    const reviewerId = await approvalMode.getSystemReviewerId(conn);

    return {
        decided: true,
        reviewerId,
        requestType: request.requestType,
        submitterId: request.accountId,
        triggeredBy
    };
}

/**
 * The automatic pass, run once after a request has been created.
 *
 * The request is already committed by the time this runs: a submission that has
 * been accepted is accepted, and an automatic approval is a second, separate
 * decision about it. Failing here must therefore never turn a successful
 * submission into an error — the caller gets a reason string and shows it.
 *
 * The transaction below is NOT the approval's transaction. It exists to do two
 * things atomically: take the pending claim (FOR UPDATE) and read the mode. Then
 * it is released and the EXISTING approver runs in its own transaction, so
 * duplicate-species handling, the primary-content promotion and the hasContent
 * gate all apply unchanged.
 *
 * Releasing before delegating is not a shortcut. approvePlantRequest takes its own
 * connection and begins its own transaction; holding a lock on the request row
 * while it ran would block any concurrent decision on the same request and could
 * deadlock against two submissions naming the same species, which the conversion
 * branch locks with `SELECT ... FROM plants WHERE scientificName = ? FOR UPDATE`.
 * The double-approve guard is claimPendingRequest, which both this function and
 * approvePlantRequest call — that is what the "must not bypass" requirement is
 * actually about, and neither one skips it.
 */
async function processNewRequest(requestId, { triggeredBy = 'submission' } = {}) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const request = await claimPendingRequest(conn, requestId);
        if (!request) {
            await conn.rollback();
            return { autoDecided: false, reason: 'the request was already resolved', rail: 'not-pending' };
        }
        const decision = await maybeAutoResolve(conn, request, { triggeredBy });
        await conn.commit();

        if (!decision.decided) {
            return { autoDecided: false, reason: decision.reason, rail: decision.rail };
        }

        const result = request.requestType === 'role_permission'
            ? await decideRoleRequest(requestId, decision.reviewerId, { approve: true })
            : await approvePlantRequest(requestId, decision.reviewerId);

        if (result.error) {
            return { autoDecided: false, reason: result.error, code: result.code };
        }
        return { autoDecided: true, ...decision, result };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Botanist submissions
// ---------------------------------------------------------------------------

/**
 * Validates a new-plant draft. Duplicate species is allowed on purpose.
 *
 * Returns { errors, warnings, clean }. The caller must store `clean`, not the
 * raw body: scientificName is a machine identifier, matched by equality against
 * the model's class list and by `WHERE scientificName IN (...)` in
 * resolveScientificNames. A leading space alone is enough to break both —
 * verified on this server (utf8mb4_0900_ai_ci): `' Ocimum basilicum' =
 * 'Ocimum basilicum'` is 0. `warnings` never blocks a submission.
 */
function validatePlantDraft(body) {
    const errors = [];
    const warnings = [];

    const clean = {
        commonName: normalizeName(body.commonName),
        scientificName: normalizeScientificName(body.scientificName),
        quantity: body.quantity === '' || body.quantity === undefined ? null : body.quantity,
        kingdom: normalizeName(body.kingdom),
        phylum: normalizeName(body.phylum),
        plantClass: normalizeName(body.plantClass),
        order: normalizeName(body.order),
        family: normalizeName(body.family),
        genus: normalizeName(body.genus),
        species: normalizeName(body.species),
        parts: {},
        uses: normalizeName(body.uses) || null,
        benefits: normalizeName(body.benefits) || null,
        harmful: normalizeName(body.harmful) || null
    };

    if (!clean.commonName) errors.push('commonName is required');
    if (!clean.scientificName) errors.push('scientificName is required');
    if (!body.typeId) errors.push('typeId is required');
    if (clean.quantity !== null && Number.isNaN(Number(clean.quantity))) {
        errors.push('quantity must be a number');
    }

    const parts = body.parts || {};
    for (const key of ['heightMinCm', 'heightMaxCm', 'widthMinCm', 'widthMaxCm']) {
        const raw = parts[key];
        if (raw !== undefined && raw !== null && raw !== '' && Number.isNaN(Number(raw))) {
            errors.push(`parts.${key} must be a number`);
        }
    }
    if (parts.heightMinCm != null && parts.heightMaxCm != null && Number(parts.heightMinCm) > Number(parts.heightMaxCm)) {
        errors.push('parts.heightMinCm cannot exceed heightMaxCm');
    }
    if (parts.widthMinCm != null && parts.widthMaxCm != null && Number(parts.widthMinCm) > Number(parts.widthMaxCm)) {
        errors.push('parts.widthMinCm cannot exceed widthMaxCm');
    }
    for (const key of PARTS_FIELDS) {
        clean.parts[key] = parts[key] === undefined ? null : parts[key];
    }

    // Public visibility requires an approved primary description, so a
    // names-only submission would be "Approved" in My Submissions and never
    // listed. Same rule validateContribution already applies.
    if (!hasAnyPartValue(clean.parts) && !clean.uses && !clean.benefits && !clean.harmful) {
        errors.push('A plant needs at least a description, some measurements, or one photo');
    }

    // Model-class match. While ml/model/main/classes.json is absent there is
    // nothing to check against, so the name is accepted as typed — the model is
    // still being trained and failing every submission would be worse than an
    // unverified name.
    const classes = loadModelClasses();
    if (classes && clean.scientificName) {
        const wanted = clean.scientificName.toLowerCase();
        const match = classes.find((c) => c.scientific.toLowerCase() === wanted);
        if (match) {
            // Rewrite to the class's exact casing so the join key is a real
            // model class, not a near-miss.
            clean.scientificName = match.scientific;
        } else {
            warnings.push(
                `"${clean.scientificName}" is not a model class, so scans will never link to it. ` +
                'The library may legitimately contain species the model does not know.'
            );
        }
    }

    return { errors, warnings, clean };
}

function validateContribution(body, imageCount) {
    const errors = [];
    const hasText = body.uses || body.benefits || body.harmful;
    const hasParts = body.parts && Object.values(body.parts).some((v) => v !== null && v !== undefined && v !== '');
    if (!hasText && !hasParts && imageCount === 0) {
        errors.push('A contribution needs at least a description, some measurements, or one photo');
    }
    return errors;
}

/**
 * Creates the plant_addition request; the draft stays in `payload` only.
 *
 * When the draft came from a claimed discovery report the payload carries
 * `discoveryRequestId`, and two things happen in the SAME transaction as the
 * insert: the claim is verified (so any botanist cannot attach a record to a
 * report another botanist is working on — the client hides the control with
 * "view only" but the client is not the authority), and the report's
 * recordRequestId is set, so a report can never point at a record that was not
 * created.
 */
async function createPlantAdditionRequest(accountId, draft) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const claimError = await assertDiscoveryClaim(conn, draft.discoveryRequestId, accountId);
        if (claimError) {
            await conn.rollback();
            return claimError;
        }
        const [typeRows] = await conn.query('SELECT typeId, typeName, label FROM plant_types WHERE typeId = ?', [draft.typeId]);
        if (typeRows.length === 0) {
            await conn.rollback();
            return { error: 'Unknown plant type', code: 400 };
        }
        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'payload', 'status'],
            [
                accountId,
                'plant_addition',
                JSON.stringify({ ...draft, typeName: typeRows[0].typeName, typeLabel: typeRows[0].label }),
                'pending'
            ]
        );
        if (draft.discoveryRequestId) {
            await linkDiscoveryRecord(conn, requestId, draft.discoveryRequestId);
        }
        await conn.commit();
        return { requestId };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** Stores uploaded files and creates the pending plant_contribution request. */
async function createPlantContributionRequest(accountId, plantId, draft, files) {
    const conn = await mysqlPool.getConnection();
    // The route's discardFiles() unlinks the pre-move path, which no longer
    // exists once a file has been renamed into place — so a mid-batch failure
    // would orphan files no query can ever reach. These are the real
    // destinations, tracked so the rollback can remove them.
    const movedPaths = [];
    try {
        await conn.beginTransaction();

        const claimError = await assertDiscoveryClaim(conn, draft.discoveryRequestId, accountId);
        if (claimError) {
            await conn.rollback();
            return claimError;
        }

        const [plantRows] = await conn.query('SELECT plantId FROM plants WHERE plantId = ? FOR UPDATE', [plantId]);
        if (plantRows.length === 0) {
            await conn.rollback();
            return { error: 'Plant not found', code: 404 };
        }

        const dir = path.join(settings.plantImages.storageDir, plantId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const imageIds = [];
        for (const file of files) {
            const ext = path.extname(file.originalname).toLowerCase();
            // Never reuse the client-supplied name on disk.
            const storedFilename = `${crypto.randomUUID()}${ext}`;
            const relativePath = path.join(plantId, storedFilename);
            const destination = path.join(settings.plantImages.storageDir, relativePath);
            fs.renameSync(file.path, destination);
            movedPaths.push(destination);
            imageIds.push(await insertRow(
                conn,
                'plant_images',
                ['plantId', 'accountId', 'originalFilename', 'storedFilename', 'storedPath', 'mimeType', 'size', 'status', 'isPrimary'],
                [plantId, accountId, file.originalname, storedFilename, relativePath, file.mimetype, file.size, 'pending', false]
            ));
        }

        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'targetPlantId', 'payload', 'status'],
            [accountId, 'plant_contribution', plantId, JSON.stringify({ ...draft, imageIds }), 'pending']
        );

        if (draft.discoveryRequestId) {
            await linkDiscoveryRecord(conn, requestId, draft.discoveryRequestId);
        }

        await conn.commit();
        return { requestId, imageIds };
    } catch (err) {
        await conn.rollback();
        for (const destination of movedPaths) {
            try {
                if (fs.existsSync(destination)) fs.unlinkSync(destination);
            } catch (cleanupErr) {
                console.error('Could not remove rolled-back upload:', destination, cleanupErr.message);
            }
        }
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * The caller's own plant submissions and where each one stands.
 *
 * EXCLUDES plant_discovery on purpose. This selects WHERE ar.accountId = ? across
 * every request type, and lets a botanist file reports — so their own
 * reports would surface here, contradicting the plan's own validation and
 * breaking the existing submissions-status whitelist (which covers only
 * pending/approved/denied) the moment a report reached cancelled or rejected.
 *
 * An INCLUSION LIST, in BOTH queries, rather than `!= 'plant_discovery'`: it
 * fails closed, so a request type added later does not appear in a user's
 * submissions until someone remembers this line. It also mirrors
 * listPlantRequests, which hardcodes its own two-type list. The COUNT is the
 * easy one to forget, and omitting it leaves the pagination total counting rows
 * the page never shows.
 *
 * A botanist's own reports stay reachable through GET /api/discoveries/mine,
 * which is accountId-scoped and is where report states belong.
 */
async function listMyRequests(accountId, { page, pageSize } = {}) {
    const paging = parsePaging({ page, pageSize });
    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.requestType, ar.status, ar.targetPlantId, ar.note,
                ar.payload, ar.createdAt, ar.reviewedAt,
                ar.reviewedBy, ar.approvalMode,
                p.commonName AS targetCommonName,
                rev.username AS reviewerName,
                CONCAT_WS(' ', revp.firstName, revp.lastName) AS reviewerLabel
         FROM approval_requests ar
         LEFT JOIN plants p ON ar.targetPlantId = p.plantId
         LEFT JOIN accounts rev ON ar.reviewedBy = rev.accountId
         LEFT JOIN profiles revp ON revp.accountId = rev.accountId
         WHERE ar.accountId = ?
           AND ar.requestType IN ('plant_addition','plant_contribution')
         ORDER BY ar.createdAt DESC
         LIMIT ? OFFSET ?`,
        [accountId, paging.pageSize, paging.offset]
    );
    const [countRows] = await mysqlPool.query(
        "SELECT COUNT(*) AS total FROM approval_requests WHERE accountId = ? " +
        "AND requestType IN ('plant_addition','plant_contribution')",
        [accountId]
    );

    // Only a plant_contribution ever carries imageIds; a plant_addition has none
    // by design, because its photos are submitted later as a separate
    // contribution and appear on that row. The ids in payload are not trusted —
    // this read is scoped to the caller's own accountIds, and the owner route
    // re-checks them.
    const imageIdsByRequest = new Map();
    const allImageIds = new Set();
    for (const r of rows) {
        const payload = parsePayload(r.payload);
        const ids = Array.isArray(payload.imageIds)
            ? payload.imageIds.filter((id) => typeof id === 'string' && id.length > 0)
            : [];
        imageIdsByRequest.set(r.requestId, ids);
        ids.forEach((id) => allImageIds.add(id));
    }

    const imageById = new Map();
    if (allImageIds.size > 0) {
        const placeholders = [...allImageIds].map(() => '?').join(',');
        const [imgRows] = await mysqlPool.query(
            `SELECT imageId, status, mimeType, size, originalFilename
             FROM plant_images WHERE accountId = ? AND imageId IN (${placeholders})`,
            [accountId, ...allImageIds]
        );
        for (const img of imgRows) imageById.set(img.imageId, img);
    }

    return {
        requests: rows.map((r) => {
            const payload = parsePayload(r.payload);
            return {
                id: r.requestId,
                requestType: r.requestType,
                status: r.status,
                targetPlantId: r.targetPlantId,
                targetPlantName: r.targetCommonName,
                note: r.note,
                createdAt: r.createdAt,
                reviewedAt: r.reviewedAt,
                reviewerName: r.reviewerName,
                // The human-readable reviewer. `reviewerName` is the username, which
                // for an automatic approval would read "system" in lower case while
                // every other page says "System" — so the submission list uses the
                // profile label, the same join the public plant page uses.
                reviewerLabel: r.reviewerLabel || r.reviewerName,
                // Lets the submissions list say AUTO instead of naming a person.
                approvalMode: r.approvalMode || 'manual',
                // The report this record was made from, when there was one. The
                // client renders the line only when the field is present, so a
                // submission with no report is unchanged.
                discoveryRequestId: payload.discoveryRequestId || null,
            // The owner route, never the public one: a pending photo must not
            // become a public, cacheable response.
            images: (imageIdsByRequest.get(r.requestId) || [])
                .map((imageId) => {
                    const img = imageById.get(imageId);
                    if (!img) return null;
                    return {
                        imageId: img.imageId,
                        url: `/api/plants/mine/images/${encodeURIComponent(img.imageId)}`,
                        status: img.status,
                        mimeType: img.mimeType,
                        size: img.size,
                        originalFilename: img.originalFilename
                    };
                })
                .filter(Boolean)
            };
        }),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize
    };
}

// ---------------------------------------------------------------------------
// Discovery reports
//
// A `user` flags a plant the model could not identify. A botanist claims it,
// records it, and an admin approves the record — which is what closes the
// report. Everything below is keyed on requestType = 'plant_discovery'.
// ---------------------------------------------------------------------------

const DISCOVERY_TYPE = 'plant_discovery';

/**
 * "Not a plant" reasons, a CLOSED set and never free text.
 *
 * The value reaches the UI as a label, so an unvalidated one here is an
 * injection surface; it also lands in a VARCHAR(32) audit column that nobody
 * could later check for sense.
 */
const DISQUALIFY_REASONS = [
    'not_a_plant',
    'not_a_photo_of_plant',
    'unusable_image',
    'already_recorded',
    'duplicate'
];

const DISCOVERY_NOTE = 'A note or at least one photo is required.';

/**
 * The two kinds of admin denial  `revise` is the default because every
 * existing Deny click sends it, and it must not silently become the harsher
 * option. Never free text: it is an action selector.
 */
const DENIAL_KINDS = ['revise', 'reject'];

/** Shared body text for "you are at a limit", so both caps read identically. */
const CLAIM_SLOT_RETRY_HINT =
    'Release or resolve one of your claims to free a slot, or wait for a report to be decided.';
const OPEN_REPORT_RETRY_HINT =
    'Wait for one of your open reports to be reviewed, or cancel one.';

/**
 * The discovery storage root. Under settings.plantImages.storageDir on purpose:
 * nothing new is statically served, and the shared fileFilter and maxSizeBytes
 * apply unchanged, so a report cannot become a way to upload something the
 * library would reject.
 */
const DISCOVERY_STORAGE_ROOT = path.join(
    settings.plantImages.storageDir,
    settings.plantImages.discoverySubdir
);

/** A claim older than this is not a reservation any more  */
function staleClaimCutoff() {
    return new Date(Date.now() - settings.discoveries.claimStaleDays * 24 * 60 * 60 * 1000);
}

/**
 * A CLAIM is live when its holder can still authenticate and the claim is
 * inside the staleness window. Computed in SQL so the truth holds between
 * sweeps, not only after prune-usage.cjs has run.
 *
 * `holder` is the LEFT JOIN alias for the claiming account.
 */
function claimIsLive(holderAlias) {
    return `(${holderAlias}.status = 'active' AND ar.claimedBy IS NOT NULL
            AND ar.claimedAt IS NOT NULL AND ar.claimedAt > ?)`;
}

/**
 * ONE definition of the electorate: active, holds record_plant, and is NOT a
 * privileged role.
 *
 * Reused by the threshold, the queue card's "N of M", dispatch eligibility and
 * the vote itself. If the card says "3 of 5" while the vote check computes 4,
 * the botanist is shown a number that can never be reached and the report is
 * unclosable — same discipline as parsePaging.
 *
 * The plan writes this as "active AND holds record_plant", which on this seed
 * data also counts superadmin and admin — they hold every permission. That is
 * excluded here, for two reasons that both come from the plan itself:
 *   - the card LABELS these accounts "botanists", and an administrator is not one
 *     (sidebar canDiscover is `record_plant && !isAdmin`);
 *   - a quorum exists so "more than one opinion" is needed before the community
 *     disposes of a user's report. Counting admins puts an administrator inside
 *     that electorate, so one admin plus one botanist satisfies a threshold of 2
 *     and the veto is exercised by a single botanist's opinion.
 * With the seeded data (exactly one botanist, acc_000002) this is what makes
 * /vote refuse with 409 and leaves the admin override as the only closure path.
 */
async function countActiveBotanists(conn) {
    const target = conn || mysqlPool;
    const [rows] = await target.query(
        `SELECT COUNT(*) AS n
         FROM accounts a
         JOIN role_permissions rp ON rp.roleId = a.roleId
         JOIN permissions p ON p.permissionId = rp.permissionId AND p.permissionName = 'record_plant'
         WHERE a.status = 'active'
           AND NOT EXISTS (
               SELECT 1 FROM role_permissions ap
               JOIN permissions apm ON apm.permissionId = ap.permissionId
               WHERE ap.roleId = a.roleId AND apm.permissionName = 'access_admin'
           )`
    );
    return Number(rows[0].n);
}

/**
 * The setting is a CEILING, not the quorum.
 *
 * A fixed number against a variable electorate changes meaning as people join or
 * leave: "5" is unanimity with five botanists and a majority with ten. So the
 * effective threshold is max(2, min(ceiling, ceil(activeBotanists / 2))) — always
 * "more than one opinion" and never "everybody".
 *
 * The floor of 2 is not optional: ceil(n / 2) alone gives 1 for one botanist and
 * 1 for two, so a single person could close every report alone.
 */
function effectiveNotAPlantThreshold(activeBotanists) {
    const ceiling = settings.discoveries.notAPlantVotes;
    return Math.max(2, Math.min(ceiling, Math.ceil(activeBotanists / 2)));
}

/** Live claims held by one botanist: the cap count. */
async function countLiveClaims(conn, accountId) {
    const [rows] = await conn.query(
        `SELECT COUNT(*) AS n
         FROM approval_requests ar
         JOIN accounts holder ON holder.accountId = ar.claimedBy
         WHERE ar.requestType = ?
           AND ar.claimedBy = ?
           AND ar.status = 'pending'
           AND ar.resolvedBy IS NULL
           AND ar.disqualifiedBy IS NULL`,
        [DISCOVERY_TYPE, accountId]
    );
    return Number(rows[0].n);
}

/**
 * A report is CLAIMABLE when its own status is still pending, the record it
 * produced is not under review, and no live claim holds it.
 *
 * Both terms are load-bearing, and the predicate is written out at each call site
 * rather than assembled here: the claim path needs it inside a conditional
 * UPDATE with a lock in front of it, and the count path needs it inside a SUM.
 * Sharing one builder across the two would hide the fact that the UPDATE needs
 * `holder` joined and the SUM needs it LEFT joined.
 *
 * Without the status term a report closed by approval or by a `reject` denial
 * would be claimable again, because its linked record is `denied` and therefore
 * no longer `pending`. Without the linked-record term a `revise`-denied report
 * would be stranded: the species was not added, so the report is live work and
 * must be recordable again.
 */

/** Shared photo read for one report. Batch callers use
 * listDiscoveryImagesForRequests instead of looping this per card. */
async function listDiscoveryImagesForRequests(requestIds) {
    const map = new Map();
    if (!requestIds.length) return map;
    const [rows] = await mysqlPool.query(
        `SELECT requestId, imageId, originalFilename, mimeType, size, uploadedAt
         FROM discovery_images
         WHERE requestId IN (${requestIds.map(() => '?').join(',')})
         ORDER BY uploadedAt ASC, imageId ASC`,
        requestIds
    );
    for (const row of rows) {
        if (!map.has(row.requestId)) map.set(row.requestId, []);
        map.get(row.requestId).push(row);
    }
    return map;
}

/** A feature switch in system_settings (moved from rbac_meta in M27a). An absent key is off, never an error. */
async function getDiscoveryFeatureFlag(key) {
    const value = await resolveSetting(mysqlPool, key);
    return value === 1 || value === '1' || value === true ? '1' : '0';
}

/** Normalises what the client sent as predictions into the stored shape. */
function normalizePredictionList(predictions) {
    if (!Array.isArray(predictions)) return [];
    return predictions
        .filter((p) => p && (p.scientificName || p.scientific_name))
        .slice(0, 10)
        .map((p) => ({
            scientificName: normalizeScientificName(p.scientificName || p.scientific_name),
            commonName: normalizeName(p.commonName || p.common_name),
            confidence: typeof p.confidence === 'number' ? p.confidence : 0
        }))
        .filter((p) => p.scientificName);
}

/** system_settings is where feature switches live, so the flag is readable without a deploy. */
async function isAutoDispatchEnabled() {
    return (await getDiscoveryFeatureFlag('discovery_auto_dispatch')) === '1';
}

/**
 *  mark the scans a report came from, so an analytical consumer can
 * tell "people scan this and it is missing" from "people scan this, flagged it,
 * and a botanist is on it".
 *
 * By scientificName plus a recent window, because mlscans lives in Mongo and
 * approval_requests in MySQL — there is no cross-database foreign key to hang
 * this on, and inventing one is not possible.
 */
async function markRecentScansReported(accountId, scientificNames) {
    if (!scientificNames || scientificNames.length === 0) return 0;
    const { Mlscan } = require('../mongoose-schemas/Mlscan.js');
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await Mlscan.updateMany(
        {
            accountId,
            createdAt: { $gte: since },
            'predictions.scientificName': { $in: scientificNames }
        },
        { $set: { reported: true } }
    );
    return result.modifiedCount || 0;
}

/**
 * assign a new report to the least-loaded active botanist.
 *
 * NOT machine approval: the dispatched report still needs a human claim
 * decision and its closure is still the record's approval. What it fixes is that
 * unclaimed reports otherwise sit with nobody.
 *
 * Called inside the caller's transaction so a dispatch can never outlive the
 * report it was assigned to.
 */
async function dispatchDiscovery(conn, requestId) {
    if (!(await isAutoDispatchEnabled())) return null;

    const botanists = await listEligibleDispatchTargets(conn);
    if (botanists.length === 0) return null;

    const [result] = await conn.query(
        `UPDATE approval_requests ar
         SET ar.claimedBy = ?, ar.claimedAt = NOW(), ar.claimSource = 'auto'
         WHERE ar.requestId = ?
           AND ar.requestType = '${DISCOVERY_TYPE}'
           AND ar.status = 'pending'
           AND ar.claimedBy IS NULL`,
        [botanists[0].accountId, requestId]
    );
    return result.affectedRows > 0 ? botanists[0].accountId : null;
}

/**
 * Dispatch eligibility, in one place.
 *
 * Skips anyone at the claim cap (the queue is genuinely full, so leaving the
 * report unclaimed and letting the sidebar dot count it is the correct outcome)
 * and anyone whose oldest live claim is older than claimStaleDays — without that
 * second rule "least loaded" quietly means "whoever was assigned last", and an
 * absent botanist accumulates claims until the queue is theirs.
 */
async function listEligibleDispatchTargets(conn) {
    const max = settings.discoveries.maxClaimsPerBotanist;
    const cutoff = staleClaimCutoff();
    // Same electorate as countActiveBotanists: dispatch assigns work, so handing
    // it to an administrator would be "least loaded" only because they never
    // claim anything by hand.
    const [rows] = await conn.query(
        `SELECT a.accountId,
                (SELECT COUNT(*) FROM approval_requests c
                  WHERE c.requestType = ? AND c.claimedBy = a.accountId
                    AND c.status = 'pending'
                    AND c.resolvedBy IS NULL
                    AND c.disqualifiedBy IS NULL) AS liveClaims,
                (SELECT MIN(c.claimedAt) FROM approval_requests c
                  WHERE c.requestType = ? AND c.claimedBy = a.accountId
                    AND c.status = 'pending'
                    AND c.resolvedBy IS NULL
                    AND c.disqualifiedBy IS NULL) AS oldestClaim
         FROM accounts a
         WHERE a.status = 'active'
           AND EXISTS (
               SELECT 1 FROM role_permissions rp
               JOIN permissions p ON p.permissionId = rp.permissionId
               WHERE rp.roleId = a.roleId AND p.permissionName = 'record_plant'
           )
           AND NOT EXISTS (
               SELECT 1 FROM role_permissions ap
               JOIN permissions apm ON apm.permissionId = ap.permissionId
               WHERE ap.roleId = a.roleId AND apm.permissionName = 'access_admin'
           )
         ORDER BY a.accountId ASC`,
        [DISCOVERY_TYPE, DISCOVERY_TYPE]
    );
    return rows
        .filter((r) => Number(r.liveClaims) < max)
        // An absent botanist stops being eligible rather than being handed more.
        .filter((r) => !r.oldestClaim || new Date(r.oldestClaim) > cutoff)
        // Fewest live claims, ties broken by lowest accountId so the result is
        // deterministic and testable.
        .sort((x, y) => Number(x.liveClaims) - Number(y.liveClaims) ||
            x.accountId.localeCompare(y.accountId));
}

/**
 * Helper: formats a retry delay in seconds to a human-readable string.
 */
function formatRetryDelay(seconds) {
    if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Helper: formats seconds ago to minutes ago string.
 */
function formatMinutesAgo(seconds) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * creates the report, its photos, and (when the switch is on) its claim.
 *
 * One transaction, and the folder is created ONLY AFTER the request row exists �
 * so the directory is keyed by a real requestId rather than anything
 * client-supplied, the same rule createPlantContributionRequest follows with
 * plantId. On any failure the moved files are unlinked and the now-empty folder
 * removed, so a rolled-back report leaves no orphan bytes and no stray directory.
 */
async function createDiscoveryReport({ accountId, note, location, predictions, files }) {
    const cleanNote = normalizeName(note);
    const cleanLocation = normalizeName(location);
    const cleanPredictions = normalizePredictionList(predictions);
    const accepted = Array.isArray(files) ? files : [];

    if (!cleanNote && accepted.length === 0) {
        return { error: DISCOVERY_NOTE, code: 400 };
    }
    if (accepted.length > settings.plantImages.maxDiscoveryFiles) {
        return {
            error: `At most ${settings.plantImages.maxDiscoveryFiles} photos per report.`,
            code: 400
        };
    }

    const conn = await mysqlPool.getConnection();
    const movedPaths = [];
    let createdDir = null;
    try {
        await conn.beginTransaction();

        // Lock the account row FIRST � the same lock claimDiscovery takes. This is
        // what makes the open-report cap atomic: a bare count-then-insert lets two
        // rapid submissions both read 9 and both succeed at 10.
        const [accountRows] = await conn.query(
            'SELECT accountId, roleId FROM accounts WHERE accountId = ? FOR UPDATE',
            [accountId]
        );
        if (accountRows.length === 0) {
            await conn.rollback();
            return { error: 'Account not found', code: 404 };
        }
        const roleId = accountRows[0]?.roleId;

        // COOLDOWN BEFORE CAP, in a fixed order. A user can be both cooled down and
        // at their limit, and the client renders one message: the cooldown is the
        // more immediate reason and its 429 carries a Retry-After the header can
        // express directly.
        const cooldown = settings.discoveries.reportCooldownMinutes;
        if (cooldown > 0) {
            const [recent] = await conn.query(
                `SELECT TIMESTAMPDIFF(SECOND, createdAt, NOW()) AS secondsAgo
                 FROM approval_requests
                 WHERE accountId = ? AND requestType = ?
                 ORDER BY createdAt DESC LIMIT 1`,
                [accountId, DISCOVERY_TYPE]
            );
            if (recent.length > 0 && Number(recent[0].secondsAgo) < cooldown * 60) {
                const retryAfter = Math.max(1, cooldown * 60 - Number(recent[0].secondsAgo));
                await conn.rollback();
                return {
                    error: `You filed a report ${formatMinutesAgo(cooldown * 60 - retryAfter)} ago. ` +
                        `Try again in ${formatRetryDelay(retryAfter)}.`,
                    code: 429,
                    retryAfterSeconds: retryAfter
                };
            }
        }

        const [openRows] = await conn.query(
            `SELECT COUNT(*) AS n FROM approval_requests
             WHERE accountId = ? AND requestType = ? AND status = 'pending'`,
            [accountId, DISCOVERY_TYPE]
        );
        const openReports = Number(openRows[0].n);
        // Resolve maxOpenReportsPerAccount from role_limits -> system_settings -> settings.js
        let maxOpenReports;
        if (roleId) {
            const resolved = await resolveLimit(conn, 'maxOpenReportsPerAccount', roleId);
            maxOpenReports = typeof resolved === 'object' ? resolved.maxOpenReportsPerAccount : resolved;
        }
        if (!maxOpenReports) maxOpenReports = settings.discoveries.maxOpenReportsPerAccount;

        if (openReports >= maxOpenReports) {
            await conn.rollback();
            // 409, not 429: a conflict with the caller's own outstanding state,
            // not a frequency limit. One response shape for "you are at a limit".
            return {
                error: OPEN_REPORT_RETRY_HINT,
                code: 409,
                openReports,
                maxOpenReports
            };
        }

        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'payload', 'status'],
            [
                accountId,
                DISCOVERY_TYPE,
                JSON.stringify({ note: cleanNote || null, location: cleanLocation || null, predictions: cleanPredictions }),
                'pending'
            ]
        );

        let imageIds = [];
        if (accepted.length > 0) {
            createdDir = path.join(DISCOVERY_STORAGE_ROOT, requestId);
            if (!fs.existsSync(createdDir)) fs.mkdirSync(createdDir, { recursive: true });

            for (const file of accepted) {
                const ext = path.extname(file.originalname).toLowerCase();
                // Never reuse the client-supplied name on disk.
                const storedFilename = `${crypto.randomUUID()}${ext}`;
                const relativePath = path.join(requestId, storedFilename);
                const destination = path.join(DISCOVERY_STORAGE_ROOT, relativePath);
                fs.renameSync(file.path, destination);
                movedPaths.push(destination);
                imageIds.push(await insertRow(
                    conn,
                    'discovery_images',
                    ['requestId', 'accountId', 'originalFilename', 'storedPath', 'mimeType', 'size'],
                    [requestId, accountId, file.originalname, relativePath, file.mimetype, file.size]
                ));
            }
        }

        const dispatchedTo = await dispatchDiscovery(conn, requestId);

        await conn.commit();

        // After the commit: Mongo is not in the transaction and must never be able
        // to fail the report.
        markRecentScansReported(
            accountId,
            cleanPredictions.map((p) => p.scientificName)
        ).catch((err) => console.error('Could not flag scans as reported:', err.message));

        return { requestId, imageIds, openReports: openReports + 1, maxOpenReports, dispatchedTo };
    } catch (err) {
        await conn.rollback();
        for (const destination of movedPaths) {
            try {
                if (fs.existsSync(destination)) fs.unlinkSync(destination);
            } catch (cleanupErr) {
                console.error('Could not remove rolled-back report upload:', destination, cleanupErr.message);
            }
        }
        if (createdDir) {
            try {
                if (fs.existsSync(createdDir)) fs.rmdirSync(createdDir);
                if (fs.existsSync(DISCOVERY_STORAGE_ROOT) && fs.readdirSync(DISCOVERY_STORAGE_ROOT).length === 0) {
                    fs.rmdirSync(DISCOVERY_STORAGE_ROOT);
                }
            } catch (cleanupErr) {
                console.error('Could not remove rolled-back report folder:', cleanupErr.message);
            }
        }
        throw err;
    } finally {
        conn.release();
    }
}async function getDiscoveryImageForOwner(imageId, accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT imageId, requestId, accountId, originalFilename, storedPath, mimeType, size
         FROM discovery_images WHERE imageId = ? AND accountId = ?`,
        [imageId, accountId]
    );
    return rows[0] || null;
}

/**
 *  the botanist's view. Status-free, because a botanist must be able to
 * read the photo they are being asked to judge. Admin-only is NOT assumed here —
 * routes/discoveries.js gates it on record_plant, and routes/admin.js uses
 * getDiscoveryImageForReview below.
 */
async function getDiscoveryImageForBotanist(imageId) {
    const [rows] = await mysqlPool.query(
        `SELECT imageId, requestId, accountId, originalFilename, storedPath, mimeType, size, uploadedAt
         FROM discovery_images WHERE imageId = ?`,
        [imageId]
    );
    return rows[0] || null;
}

/** the admin review route, status-free and never cached. */
async function getDiscoveryImageForReview(imageId) {
    return getDiscoveryImageForBotanist(imageId);
}

/**
 * the botanist queue.
 *
 * NEVER filtered by claim — a claimed report stays visible, carrying who has it
 * and when. Only `status = 'pending'` filters, which is why a report closed by
 * approval  or by a `reject` denial leaves the queue for
 * good, and a `revise`-denied one stays in it as live work.
 */
async function listPendingDiscoveries({ page, pageSize } = {}) {
    const paging = parsePaging({ page, pageSize });
    const activeBotanists = await countActiveBotanists();
    const threshold = effectiveNotAPlantThreshold(activeBotanists);

    const SELECT = `
        SELECT ar.requestId, ar.status, ar.createdAt, ar.note, ar.payload,
               ar.claimedBy, ar.claimedAt, ar.claimSource,
               ar.resolvedBy, ar.resolvedAt,
               ar.recordRequestId, ar.targetPlantId,
               ar.disqualifiedBy, ar.disqualifiedAt, ar.disqualifyReason,
               a.accountId AS reporterId, a.username AS reporterName,
               pr.firstName AS reporterFirstName, pr.lastName AS reporterLastName,
               claimer.username AS claimerName,
               cpr.firstName AS claimerFirstName, cpr.lastName AS claimerLastName,
               resolver.username AS resolverName,
disqualifier.username AS disqualifierName,
                -- REQUIRED, not decorative. mapDiscoveryCard computes a LIVE claim
                -- from holder.status plus claimedAt, and without this column the
                -- expression is always false: a claimed report renders with no claim
                -- at all, claimable reads true on it, and the queue offers a Claim
                -- button on work somebody is already doing. The server still refuses
                -- the claim, so nothing is corrupted — but the queue is then lying
                -- about the one thing it exists to coordinate.
                holder.status AS holderStatus,
                (SELECT r.status FROM approval_requests r WHERE r.requestId = ar.recordRequestId) AS recordStatus,
               (SELECT COUNT(*) FROM discovery_votes v WHERE v.requestId = ar.requestId) AS voteCount
        FROM approval_requests ar
        JOIN accounts a ON a.accountId = ar.accountId
        LEFT JOIN profiles pr ON pr.accountId = a.accountId
        LEFT JOIN accounts claimer ON claimer.accountId = ar.claimedBy
        LEFT JOIN profiles cpr ON cpr.accountId = ar.claimedBy
        LEFT JOIN accounts resolver ON resolver.accountId = ar.resolvedBy
        LEFT JOIN accounts disqualifier ON disqualifier.accountId = ar.disqualifiedBy
        LEFT JOIN accounts holder ON holder.accountId = ar.claimedBy`;

    const [rows] = await mysqlPool.query(
        `${SELECT}
         WHERE ar.requestType = ? AND ar.status = 'pending'
         ORDER BY (ar.disqualifiedBy IS NOT NULL) ASC,
                  (ar.resolvedBy IS NOT NULL) ASC,
                  ar.createdAt DESC
         LIMIT ? OFFSET ?`,
        [DISCOVERY_TYPE, paging.pageSize, paging.offset]
    );
    // LEFT JOIN, or an INNER JOIN: an unclaimed report has claimedBy = NULL and no
// matching holder row, so an inner join drops exactly the reports the queue exists
// to show. The result was a card list of N rows against total = 0, which breaks
// every pagination control. `holder` is not referenced by this COUNT at all — it
// was left joined in by habit.
const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total FROM approval_requests ar
         WHERE ar.requestType = ? AND ar.status = 'pending'`,
        [DISCOVERY_TYPE]
    );

    const imagesByRequest = await listDiscoveryImagesForRequests(rows.map((r) => r.requestId));
    const requests = rows.map((r) => mapDiscoveryCard(r, imagesByRequest.get(r.requestId) || [], {
        activeBotanists, threshold
    }));

    return {
        requests,
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize,
        activeBotanists,
        notAPlantThreshold: threshold,
        notAPlantVotes: settings.discoveries.notAPlantVotes
    };
}

/**
 * The one row shape every queue card is built from: the botanist queue, the
 * admin queue and the outcome reads all go through here, so a card cannot show
 * a claim state its own endpoint did not compute.
 */
function mapDiscoveryCard(row, images, options = {}) {
    const payload = parsePayload(row.payload);
    const cutoff = staleClaimCutoff();
    const claimLive = Boolean(row.claimedBy) &&
        row.holderStatus === 'active' &&
        row.claimedAt && new Date(row.claimedAt) > cutoff;
    // A stale claim is not shown as a claim: displaying one nobody holds is
    // exactly the phantom the expiry rule exists to prevent.
    const showClaim = claimLive ? row.claimedBy : null;
    const photosPurged = (row.reviewedAt && row.disqualifiedBy && images.length === 0 &&
        row.reviewedAt < new Date(Date.now() - settings.discoveries.discoveryClosedPhotoDays * 86400000));

    return {
        requestId: row.requestId,
        status: row.status,
        submittedAt: row.createdAt,
        note: payload.note || row.note || null,
        location: payload.location || null,
        predictions: Array.isArray(payload.predictions) ? payload.predictions : [],
        reporterId: row.reporterId,
        reporterName: [row.reporterFirstName, row.reporterLastName].filter(Boolean).join(' ')
            || row.reporterName,
        images: images.map((img) => ({
            imageId: img.imageId,
            // The BOTANIST queue's route, not the reporter's. The two differ only
            // in their gate — owner match versus record_plant — so a botanist
            // sent here gets a 404 on a photo they are allowed to see.
            url: `/api/discoveries/report-images/${encodeURIComponent(img.imageId)}`,
            mimeType: img.mimeType,
            size: img.size,
            originalFilename: img.originalFilename
        })),
        photosPurged: Boolean(photosPurged),
        claimedBy: showClaim,
        claimedByName: showClaim
            ? ([row.claimerFirstName, row.claimerLastName].filter(Boolean).join(' ') || row.claimerName)
            : null,
        claimedAt: claimLive ? row.claimedAt : null,
        claimAgeDays: claimLive && row.claimedAt
            ? Math.floor((Date.now() - new Date(row.claimedAt).getTime()) / 86400000)
            : null,
        claimSource: claimLive ? row.claimSource : null,
        claimStale: Boolean(row.claimedBy) && !claimLive,
        resolvedBy: row.resolvedBy,
        resolvedAt: row.resolvedAt,
        resolverName: row.resolverName || null,
        recordRequestId: row.recordRequestId,
        recordStatus: row.recordStatus || null,
        targetPlantId: row.targetPlantId || null,
        disqualifiedBy: row.disqualifiedBy,
        disqualifiedAt: row.disqualifiedAt,
        disqualifyReason: row.disqualifyReason || null,
        disqualifierName: row.disqualifierName || null,
        voteCount: Number(row.voteCount || 0),
        notAPlantThreshold: options.threshold ?? null,
        activeBotanists: options.activeBotanists ?? null,
        claimable: !claimLive && row.status === 'pending' &&
            (!row.recordStatus || row.recordStatus !== 'pending')
    };
}

/** the sidebar dot. The DOT counts unclaimed, not pending. */
async function getDiscoveryCounts() {
    const cutoff = staleClaimCutoff();
    const [rows] = await mysqlPool.query(
        `SELECT
            SUM(CASE WHEN ar.status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN ar.status = 'pending'
                      AND NOT ${claimIsLive('holder')}
                      AND (ar.recordRequestId IS NULL
                           OR (SELECT rec.status FROM approval_requests rec WHERE rec.requestId = ar.recordRequestId) <> 'pending')
                     THEN 1 ELSE 0 END) AS unclaimed
         FROM approval_requests ar
         LEFT JOIN accounts holder ON holder.accountId = ar.claimedBy
         WHERE ar.requestType = ?`,
        [cutoff, DISCOVERY_TYPE]
    );
    return {
        pending: Number(rows[0].pending || 0),
        unclaimed: Number(rows[0].unclaimed || 0)
    };
}

/**
 * claim a report.
 *
 * The whole concurrency story is one line: UPDATE ... WHERE the report is still
 * unheld, then check affectedRows. Two botanists racing produce one winner and
 * one clean 409, with no lock table and no FOR UPDATE retry loop.
 *
 * The accounts-row lock is a separate concern from that: it serialises claims BY
 * THE SAME botanist so the cap cannot be raced, while leaving different
 * botanists fully concurrent — the only contention that exists here. Without it
 * two rapid clicks both read a count of 4 and both succeed at 5, which makes the
 * cap advisory and defeats the point of adding it.
 */
async function claimDiscovery(requestId, accountId, { source = 'manual' } = {}) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT ar.requestId, ar.claimedBy, ar.claimedAt, ar.status, ar.recordRequestId,
                    claimer.username AS claimerName, holder.status AS holderStatus
             FROM approval_requests ar
             LEFT JOIN accounts claimer ON claimer.accountId = ar.claimedBy
             LEFT JOIN accounts holder ON holder.accountId = ar.claimedBy
             WHERE ar.requestId = ? AND ar.requestType = ?`,
            [requestId, DISCOVERY_TYPE]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        const report = rows[0];

        // Re-claiming a report you already hold returns the SAME 409 the race
        // produces, and is checked BEFORE the cap: it must not read as "at cap"
        // and must not consume a slot.
        if (report.claimedBy === accountId) {
            await conn.rollback();
            return {
                error: 'You already claimed this report',
                code: 409,
                reason: 'already-claimed-by-you'
            };
        }

        // Get roleId for per-role maxClaimsPerBotanist limit
        const [accountRows] = await conn.query('SELECT roleId FROM accounts WHERE accountId = ? FOR UPDATE', [accountId]);
        const roleId = accountRows[0]?.roleId;

        const activeClaims = await countLiveClaims(conn, accountId);
        // Resolve maxClaimsPerBotanist from role_limits -> system_settings -> settings.js
        let maxClaims;
        if (roleId) {
            const resolved = await resolveLimit(conn, 'maxClaimsPerBotanist', roleId);
            maxClaims = typeof resolved === 'object' ? resolved.maxClaimsPerBotanist : resolved;
        }
        if (!maxClaims) maxClaims = settings.discoveries.maxClaimsPerBotanist;

        if (activeClaims >= maxClaims) {
            await conn.rollback();
            return {
                error: CLAIM_SLOT_RETRY_HINT,
                code: 409,
                activeClaims,
                maxClaims
            };
        }

        // The linked record's status is resolved HERE rather than in a subquery
        // inside the UPDATE: MySQL refuses to read the target table from a
        // subquery in an UPDATE ("You can't specify target table 'ar' for update
        // in FROM clause"), so the whole "submitted is terminal" guard would have
        // to be dropped to keep the subquery.
        const recordStatus = report.recordRequestId
            ? (await conn.query(
                'SELECT status FROM approval_requests WHERE requestId = ?',
                [report.recordRequestId]
            ))[0][0]?.status || null
            : null;

        const SET_CLAIMABLE = `requestId = ? AND requestType = ? AND status = 'pending' AND ? = 1`;

        // Attempt 1: the report is unheld. This one line is the whole concurrency
        // story � two botanists racing produce one winner and one clean 409, with
        // no lock table and no FOR UPDATE retry loop.
        const [fresh] = await conn.query(
            `UPDATE approval_requests
             SET claimedBy = ?, claimedAt = NOW(), claimSource = ?
             WHERE requestId = ? AND requestType = ? AND status = 'pending' AND ? = 1
               AND claimedBy IS NULL`,
            [accountId, source, requestId, DISCOVERY_TYPE, recordStatus !== 'pending' ? 1 : 0]
        );

        let claimed = fresh.affectedRows > 0;

        // Attempt 2: the claim is NOT live. That covers two different situations and
        // both must be takeable, because the card has already told the botanist the
        // report is claimable:
        //
        //   - a DEAD holder. Accounts are suspended, never deleted, so ON DELETE SET
        //     NULL never fires and a suspended botanist's claimedBy would otherwise
        //     stay set forever � nobody else can claim (claimedBy IS NULL) and the
        //     owner cannot act. A claim held by an account that cannot authenticate
        //     is a DEAD claim, not a reservation.
        //   - a STALE holder, older than claimStaleDays. Guarding only on the
        //     holder's status made the card and the server disagree: the card
        //     computes "live" as active AND recent, so it offered Claim, and the
        //     server answered 409 because the holder happened to still be active.
        //     "Live" has to mean the same thing in both places or one of them is
        //     always wrong.
        //
        // Still a conditional UPDATE, and the previous holder is in its WHERE, so
        // two botanists taking the same unheld report still yield one winner.
        const notLive = report.claimedBy && (
            report.holderStatus !== 'active' ||
            !report.claimedAt ||
            new Date(report.claimedAt) <= staleClaimCutoff()
        );
        if (!claimed && notLive) {
            const [takeover] = await conn.query(
                `UPDATE approval_requests
                 SET claimedBy = ?, claimedAt = NOW(), claimSource = ?
                 WHERE ${SET_CLAIMABLE} AND claimedBy = ?`,
                [accountId, source, requestId, DISCOVERY_TYPE,
                    recordStatus !== 'pending' ? 1 : 0, report.claimedBy]
            );
            claimed = takeover.affectedRows > 0;
        }

        if (!claimed) {
            await conn.rollback();
            return { error: await explainUnclaimable(requestId), code: 409 };
        }

        // A claim closes the vote, and it removes only the CLAIMER's own ballot.
        // Clearing the tally would let one person erase a near-unanimous verdict
        // without writing anything; the claimer is simply disqualified from being
        // one of the votes that rejects work they then take up.
        await conn.query(
            'DELETE FROM discovery_votes WHERE requestId = ? AND accountId = ?',
            [requestId, accountId]
        );

        await conn.commit();
        return { requestId, claimedBy: accountId, activeClaims: activeClaims + 1, maxClaims };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}async function explainUnclaimable(requestId) {
    const [rows] = await mysqlPool.query(
        `SELECT ar.status, ar.claimedBy, ar.recordRequestId, ar.claimedAt,
                claimer.username AS claimerName,
                (SELECT rec.status FROM approval_requests rec WHERE rec.requestId = ar.recordRequestId) AS recordStatus
         FROM approval_requests ar
         LEFT JOIN accounts claimer ON claimer.accountId = ar.claimedBy
         WHERE ar.requestId = ?`,
        [requestId]
    );
    if (rows.length === 0) return 'Discovery report not found';
    const r = rows[0];
    if (r.status !== 'pending') {
        return `This report is already ${r.status} and cannot be claimed.`;
    }
    if (r.recordStatus === 'pending') {
        return 'This report already has a record awaiting review.';
    }
    if (r.claimedBy) {
        return `${r.claimerName || 'Another botanist'} claimed this ${formatAge(r.claimedAt)}.`;
    }
    return 'This report cannot be claimed.';
}

function formatAge(timestamp) {
    if (!timestamp) return 'recently';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
    if (seconds < 120) return 'just now';
    if (seconds < 7200) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * releases YOUR OWN claim. Owner-only by default, so two botanists
 * cannot fight over the same report by ping-ponging it.
 *
 * This is the accessibility path the claim cap exists to serve: at the limit,
 * drop one and pick up another.
 */
async function unclaimDiscovery(requestId, accountId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query(
            `UPDATE approval_requests
             SET claimedBy = NULL, claimedAt = NULL, claimSource = 'manual'
             WHERE requestId = ? AND requestType = ? AND claimedBy = ?`,
            [requestId, DISCOVERY_TYPE, accountId]
        );
        if (result.affectedRows === 0) {
            await conn.rollback();
            // 409 rather than 404: the caller may or may not have held it, and
            // "someone else holds it" is the actionable answer.
            return { error: 'You do not hold this claim', code: 409 };
        }
        await conn.commit();
        return { requestId };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 *  the escape hatch for a claim that can never be released normally.
 *
 * Permitted when EITHER the caller holds access_admin, OR the holder is no longer
 * `active`. Accounts are suspended rather than deleted, so ON DELETE SET NULL
 * never fires and a suspended botanist's claimedBy would otherwise stay set
 * forever: nobody else can claim (claimedBy IS NULL) and the owner cannot act.
 * That is the one case where "advisory" stops being advisory — a claim you can
 * see but cannot take. A claim held by an account that cannot authenticate is a
 * DEAD claim, not a reservation.
 */
async function releaseDiscovery(requestId, actorId, actorPermissions) {
    const isAdmin = (actorPermissions || []).includes('access_admin');
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT ar.claimedBy, ar.claimedAt, ar.status, ar.recordRequestId,
                    ar.disqualifiedBy, holder.status AS holderStatus,
                    holder.username AS holderName
             FROM approval_requests ar
             LEFT JOIN accounts holder ON holder.accountId = ar.claimedBy
             WHERE ar.requestId = ? AND ar.requestType = ?`,
            [requestId, DISCOVERY_TYPE]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        const report = rows[0];
        if (!report.claimedBy) {
            await conn.rollback();
            return { error: 'This report has no claim to release', code: 409 };
        }
        if (!isAdmin && report.holderStatus === 'active') {
            // Owner-only stays the default so the ping-pong race is impossible;
            // an admin is the only actor who can take a LIVE claim.
            await conn.rollback();
            return { error: 'Only an admin can release a live claim', code: 403 };
        }

        const previousHolder = report.claimedBy;
        await conn.query(
            `UPDATE approval_requests
             SET claimedBy = NULL, claimedAt = NULL, claimSource = 'manual'
             WHERE requestId = ?`,
            [requestId]
        );
        await conn.commit();

        // After the commit, never inside it: an audit-logging failure must not be
        // able to un-release a claim that was correctly released.
        await logImageReview({
            requestId,
            requestType: DISCOVERY_TYPE,
            imageId: null,
            plantId: null,
            accountId: previousHolder,
            decision: 'claim_released',
            reviewedBy: actorId,
            note: `Released by ${actorId} (previous holder ${previousHolder})`
        });

        return { requestId, previousHolder };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * "I am finished with this". Requires holding the claim, enforced in
 * the WHERE clause, so "resolved" always has an author.
 *
 * Deliberately orthogonal to approval_requests.status: a botanist can close a
 * report while the resulting record still awaits an admin, and if resolvedAt
 * were ever used to gate the queue those two states would disagree — which is
 * normal, not a bug.
 */
async function resolveDiscovery(requestId, accountId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT claimedBy, resolvedBy FROM approval_requests
             WHERE requestId = ? AND requestType = ?`,
            [requestId, DISCOVERY_TYPE]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        if (rows[0].resolvedBy) {
            await conn.rollback();
            return { error: 'This report is already resolved', code: 409 };
        }
        if (rows[0].claimedBy !== accountId) {
            await conn.rollback();
            return { error: 'You must hold the claim to resolve this report', code: 409 };
        }
        await conn.query(
            'UPDATE approval_requests SET resolvedBy = ?, resolvedAt = NOW() WHERE requestId = ?',
            [accountId, requestId]
        );
        await conn.commit();
        return { requestId, resolvedBy: accountId };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * undo your OWN resolution. Deliberately different from
 * reopenDisqualified (any botanist) and from unclaim (owner-only): undoing your
 * own note is a correction.
 */
async function reopenDiscovery(requestId, accountId) {
    const [result] = await mysqlPool.query(
        `UPDATE approval_requests SET resolvedBy = NULL, resolvedAt = NULL
         WHERE requestId = ? AND requestType = ? AND resolvedBy = ?`,
        [requestId, DISCOVERY_TYPE, accountId]
    );
    if (result.affectedRows === 0) {
        return { error: 'Only the botanist who resolved this report can reopen it', code: 409 };
    }
    return { requestId };
}

/**
 * a single botanist's "not a plant" verdict.
 *
 * NOT a status: `status` is admin-owned, `denied` already means an admin
 * rejected the submission, and a botanist may disqualify a report that is already
 * auto-approved — a status transition has nowhere to go from `approved`.
 *
 * Requires holding the claim, so a verdict always has an author. It does NOT
 * set resolvedAt: it is a separate disposition, and conflating them would
 * recreate the ambiguity resolvedBy / recordRequestId exist to prevent.
 *
 * It DOES release the claim, in the same statement. A live claim closes the vote
 * (castNotAPlantVote), so keeping it would make the verdict unfalsifiable: the
 * report stays visible, labelled and contestable to every botanist, and the only
 * person entitled to vote on it is the person who just made it. The queue would
 * then freeze behind the verdict's own author until they released the claim by
 * hand or it went stale — a community judgement that one member has to unlock is
 * not a judgement. Releasing here hands the report straight back to the queue and
 * to the quorum, and the verdict stays reversible by ANY botanist via
 * reinstateDisqualified, which clears both the disqualification and the ballots.
 *
 * One statement, not a claim write followed by a release: the `claimedBy = ?`
 * guard and the clearing have to be the same row version, or a second botanist
 * could claim the report in between and have their claim silently erased.
 */
async function disqualifyDiscovery(requestId, accountId, reason) {
    if (!DISQUALIFY_REASONS.includes(reason)) {
        return {
            error: `reason must be one of: ${DISQUALIFY_REASONS.join(', ')}`,
            code: 400
        };
    }
    const [result] = await mysqlPool.query(
        `UPDATE approval_requests
         SET disqualifiedBy = ?, disqualifiedAt = NOW(), disqualifyReason = ?,
             claimedBy = NULL, claimedAt = NULL, claimSource = 'manual'
         WHERE requestId = ? AND requestType = ? AND claimedBy = ?`,
        [accountId, reason, requestId, DISCOVERY_TYPE, accountId]
    );
    if (result.affectedRows === 0) {
        return { error: 'You must hold the claim to record this verdict', code: 409 };
    }
    await logImageReview({
        requestId,
        requestType: DISCOVERY_TYPE,
        imageId: null,
        plantId: null,
        accountId,
        decision: 'disqualified',
        reviewedBy: accountId,
        note: `${reason} (claim released by the verdict)`
    });
    return { requestId, disqualifiedBy: accountId, disqualifyReason: reason, claimReleased: true };
}

/**
 *  undo a "not a plant".
 *
 * Open to ANY botanist, unlike reopen (author-only). A wrong "not a plant" call
 * hides a real report from everyone, so the remedy must not be gated behind
 * being the person who made the mistake.
 *
 * Clears the vote rows, not just the disqualification: otherwise the same votes
 * would immediately re-fire the moment the report is reopened. A quorum
 * rejection additionally has to reset status from 'rejected' back to 'pending',
 * because that is the only place the quorum wrote a status. A single verdict
 * needs no status change.
 */
async function reinstateDisqualified(requestId, accountId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            'SELECT disqualifiedBy, disqualifiedAt, status FROM approval_requests WHERE requestId = ? AND requestType = ?',
            [requestId, DISCOVERY_TYPE]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        const wasQuorum = rows[0].status === 'rejected';
        if (!rows[0].disqualifiedBy && !wasQuorum) {
            await conn.rollback();
            return { error: 'This report is not marked as not-a-plant', code: 409 };
        }

        await conn.query(
            `UPDATE approval_requests
             SET disqualifiedBy = NULL, disqualifiedAt = NULL, disqualifyReason = NULL
             WHERE requestId = ?`,
            [requestId]
        );
        if (wasQuorum) {
            await conn.query(
                "UPDATE approval_requests SET status = 'pending' WHERE requestId = ? AND status = 'rejected'",
                [requestId]
            );
        }
        await conn.query('DELETE FROM discovery_votes WHERE requestId = ?', [requestId]);
        await conn.commit();

        await logImageReview({
            requestId,
            requestType: DISCOVERY_TYPE,
            imageId: null,
            plantId: null,
            accountId,
            decision: 'disqualification_overridden',
            reviewedBy: accountId,
            note: wasQuorum ? 'Quorum rejection reinstated' : 'Not-a-plant verdict reinstated'
        });

        return { requestId, reinstated: true, wasQuorum };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function countNotAPlantVotes(requestId) {
    const [rows] = await mysqlPool.query(
        'SELECT COUNT(*) AS n FROM discovery_votes WHERE requestId = ?',
        [requestId]
    );
    return Number(rows[0].n);
}

/**
 * the quorum.
 *
 * A single botanist closing a report disposes of another user's contribution, and
 * the queue is small enough that one wrong call would be unappealable — so the
 * threshold is a community judgement, and a single botanist's verdict
 * (disqualifyDiscovery) stays reinstate-able instead.
 *
 * Insert-or-delete against the composite PK, so a botanist can RETRACT a vote
 * rather than being stuck with it.
 *
 * Below the floor the endpoint refuses rather than storing a ballot that cannot
 * decide anything: a stored-but-inert vote reads as a bug to whoever cast it.
 */
async function castNotAPlantVote(requestId, accountId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const activeBotanists = await countActiveBotanists(conn);
        const threshold = effectiveNotAPlantThreshold(activeBotanists);
        if (activeBotanists < 2) {
            await conn.rollback();
            return {
                error: `Voting needs at least 2 active botanists; there ${activeBotanists === 1 ? 'is' : 'are'} ` +
                    `${activeBotanists}. An admin can close this report instead.`,
                code: 409,
                activeBotanists,
                threshold,
                requiresBotanists: 2
            };
        }

        const [rows] = await conn.query(
            `SELECT ar.requestType, ar.status, ar.recordRequestId, ar.disqualifiedBy,
                    ar.claimedBy, ar.claimedAt, holder.status AS holderStatus,
                    (SELECT rec.status FROM approval_requests rec WHERE rec.requestId = ar.recordRequestId) AS recordStatus
             FROM approval_requests ar
             LEFT JOIN accounts holder ON holder.accountId = ar.claimedBy
             WHERE ar.requestId = ?`,
            [requestId]
        );
        if (rows.length === 0 || rows[0].requestType !== DISCOVERY_TYPE) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        const report = rows[0];

        // OPEN means: pending, no submitted record, and no LIVE claim. Defining it
        // precisely is what stops the rule deadlocking — a botanist who claims and
        // then goes quiet would otherwise block a rejection indefinitely,
        // reintroducing exactly the stranding releaseDiscovery exists to prevent.
        // Once the claim goes stale it stops being live and voting resumes.
        const claimLive = Boolean(report.claimedBy) &&
            report.holderStatus === 'active' &&
            report.claimedAt && new Date(report.claimedAt) > staleClaimCutoff();
        if (report.status !== 'pending' || report.recordRequestId || claimLive) {
            await conn.rollback();
            const why = claimLive
                ? 'This report is claimed; a claim closes the vote.'
                : report.recordRequestId
                    ? 'This report already has a record awaiting review.'
                    : `This report is already ${report.status}.`;
            return { error: why, code: 409, voteCount: await countNotAPlantVotes(requestId) };
        }

        // ONE POST, either action: an existing ballot is RETRACTED, and a botanist
        // with no ballot casts one. So this must ask which of the two it is before
        // writing.
        //
        // Delete-then-insert unconditionally looks equivalent and is not: it always
        // ends with an INSERT, so a second POST from the same botanist re-added the
        // ballot they were trying to withdraw and the tally went back UP. The
        // delete made the double-vote structurally impossible and hid that it had
        // also made retraction impossible.
        const [existing] = await conn.query(
            'SELECT 1 AS present FROM discovery_votes WHERE requestId = ? AND accountId = ?',
            [requestId, accountId]
        );
        const retracting = existing.length > 0;
        if (retracting) {
            await conn.query(
                'DELETE FROM discovery_votes WHERE requestId = ? AND accountId = ?',
                [requestId, accountId]
            );
        } else {
            await conn.query(
                'INSERT INTO discovery_votes (requestId, accountId) VALUES (?, ?)',
                [requestId, accountId]
            );
        }

        const [tallyRows] = await conn.query(
            'SELECT COUNT(*) AS n FROM discovery_votes WHERE requestId = ?',
            [requestId]
        );
        const voteCount = Number(tallyRows[0].n);

        if (voteCount >= threshold) {
            // reviewedBy names the botanist whose vote crossed the threshold, NOT a
            // system account: a quorum is N humans deciding, so attributing it to
            // System would miscredit the community and contradict disqualifiedBy in
            // the same row. discovery_votes is the complete audit and is NOT
            // mirrored into Mongo.
            await conn.query(
                `UPDATE approval_requests
                 SET status = 'rejected',
                     disqualifiedBy = ?, disqualifiedAt = NOW(), disqualifyReason = 'not_a_plant',
                     reviewedBy = ?, reviewedAt = NOW()
                 WHERE requestId = ?`,
                [accountId, accountId, requestId]
            );
        }

        await conn.commit();
        return {
            requestId,
            voteCount,
            threshold,
            activeBotanists,
            // Told to the caller rather than inferred: a client cannot tell a
            // retraction from a cast vote from the count alone.
            retracted: retracting,
            rejected: voteCount >= threshold
        };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * the admin audit view. This is the ONLY place voter identities appear
 * — a reporter sees a count, never names.
 *
 * The rows ARE the storage. A reviewedByNames = "acc_000001,acc_000002,…"
 * column would defeat the whole table: the composite PK is what makes
 * double-voting impossible, and collapsing rows into one value removes that,
 * makes "which reports did this botanist vote on?" a LIKE that also matches
 * acc_0000041, breaks retraction, and keeps a deleted account's id forever with
 * no FK to clean it up.
 */
async function listNotAPlantVoters(requestId) {
    const activeBotanists = await countActiveBotanists();
    const threshold = effectiveNotAPlantThreshold(activeBotanists);
    const [rows] = await mysqlPool.query(
        `SELECT v.accountId, a.username, v.votedAt,
                COALESCE(NULLIF(CONCAT(pr.firstName, ' ', pr.lastName), ' '), a.username) AS fullName
         FROM discovery_votes v
         JOIN accounts a ON a.accountId = v.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         WHERE v.requestId = ?
         ORDER BY v.votedAt ASC, v.accountId ASC`,
        [requestId]
    );
    return {
        requestId,
        threshold,
        configured: settings.discoveries.notAPlantVotes,
        activeBotanists,
        voters: rows.map((r) => ({
            accountId: r.accountId,
            username: r.username,
            fullName: r.fullName,
            votedAt: r.votedAt
        }))
    };
}

/**
 * the admin override, which is the only path that closes a report for a
 * team with fewer than two active botanists.
 *
 * Its OWN write, deliberately: disqualifyDiscovery requires holding the
 * claim, enforced in its WHERE, and an admin holds no claim — so routing the
 * override through it would return 409 for every admin, making the one path that
 * makes the threshold survivable for a small team the one path that never works.
 *
 * audited as 'admin_override' so "the community agreed" and "an admin decided
 * alone" stay distinguishable, and so it round-trips through imgreviews at all.
 */
async function adminDisqualifyDiscovery(requestId, adminId, reason) {
    if (!DISQUALIFY_REASONS.includes(reason)) {
        return { error: `reason must be one of: ${DISQUALIFY_REASONS.join(', ')}`, code: 400 };
    }
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            'SELECT status, disqualifiedBy FROM approval_requests WHERE requestId = ? AND requestType = ?',
            [requestId, DISCOVERY_TYPE]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        if (rows[0].status === 'rejected') {
            await conn.rollback();
            return { error: 'This report is already rejected', code: 409 };
        }

        await conn.query(
            `UPDATE approval_requests
             SET status = 'rejected',
                 disqualifiedBy = ?, disqualifiedAt = NOW(), disqualifyReason = ?,
                 reviewedBy = ?, reviewedAt = NOW()
             WHERE requestId = ?`,
            [adminId, reason, adminId, requestId]
        );
        // Clears the vote rows like any other closure, so a reinstated report
        // cannot immediately re-fire the same ballots.
        await conn.query('DELETE FROM discovery_votes WHERE requestId = ?', [requestId]);
        await conn.commit();

        await logImageReview({
            requestId,
            requestType: DISCOVERY_TYPE,
            imageId: null,
            plantId: null,
            accountId: rows[0].disqualifiedBy || adminId,
            decision: 'admin_override',
            reviewedBy: adminId,
            note: reason
        });

        return { requestId, status: 'rejected', disqualifiedBy: adminId, disqualifyReason: reason };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 *  a reporter withdraws their own report.
 *
 * Owner-only, and only while it is still `pending`, no record has been
 * submitted, and it is inside settings.discoveries.cancelGraceHours. Anything
 * else is a 409 with a reason.
 *
 * The row is KEPT, not deleted: it is how an admin spots an account cycling
 * reports, and reviewedBy = the reporter so the audit trail shows who withdrew it.
 * The photos go at once, because the submitter withdrew it and nothing is owed —
 * a denial only defers the same purge to discoveryClosedPhotoDays.
 */
async function cancelDiscoveryReport(requestId, accountId) {
    const conn = await mysqlPool.getConnection();
    let removedFiles = [];
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT ar.status, ar.recordRequestId, ar.claimedBy, ar.createdAt,
                    TIMESTAMPDIFF(MINUTE, ar.createdAt, NOW()) AS minutesOld
             FROM approval_requests ar
             WHERE ar.requestId = ? AND ar.requestType = ? AND ar.accountId = ?`,
            [requestId, DISCOVERY_TYPE, accountId]
        );
        if (rows.length === 0) {
            // 404, never 403: another account must not be able to confirm that
            // someone else's report exists, and neither must an admin.
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        const report = rows[0];
        if (report.status !== 'pending') {
            await conn.rollback();
            return { error: `This report is already ${report.status} and can no longer be withdrawn.`, code: 409 };
        }
        if (report.recordRequestId) {
            await conn.rollback();
            return { error: 'A botanist already recorded this report, so it can no longer be withdrawn.', code: 409 };
        }
        const grace = settings.discoveries.cancelGraceHours;
        if (Number(report.minutesOld) > grace * 60) {
            await conn.rollback();
            return {
                error: `Reports can only be withdrawn within ${grace} hours of filing.`,
                code: 409
            };
        }

        const [images] = await conn.query(
            'SELECT storedPath FROM discovery_images WHERE requestId = ?',
            [requestId]
        );
        await conn.query('DELETE FROM discovery_images WHERE requestId = ?', [requestId]);
        // A claim is released on cancel, so the botanist's queue card disappears
        // rather than sitting on work that no longer exists.
        await conn.query(
            `UPDATE approval_requests
             SET status = 'cancelled', reviewedBy = ?, reviewedAt = NOW(),
                 claimedBy = NULL, claimedAt = NULL, claimSource = 'manual'
             WHERE requestId = ?`,
            [accountId, requestId]
        );
        await conn.commit();

        removedFiles = images.map((img) => path.join(DISCOVERY_STORAGE_ROOT, img.storedPath));
        for (const destination of removedFiles) {
            try {
                if (fs.existsSync(destination)) fs.unlinkSync(destination);
            } catch (cleanupErr) {
                console.error('Could not remove cancelled report upload:', cleanupErr.message);
            }
        }
        removeEmptyDiscoveryFolders(requestId);

        return { requestId, removedImages: removedFiles.length };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** Removes the request's folder, then the discovery root when it is empty. */
function removeEmptyDiscoveryFolders(requestId) {
    try {
        const requestDir = path.join(DISCOVERY_STORAGE_ROOT, requestId);
        if (fs.existsSync(requestDir) && fs.readdirSync(requestDir).length === 0) {
            fs.rmdirSync(requestDir);
        }
        if (fs.existsSync(DISCOVERY_STORAGE_ROOT) && fs.readdirSync(DISCOVERY_STORAGE_ROOT).length === 0) {
            fs.rmdirSync(DISCOVERY_STORAGE_ROOT);
        }
    } catch (err) {
        console.error('Could not remove discovery folders:', err.message);
    }
}

/**
 * the reporter's own view.
 *
 * `state` is a CLOSED SET COMPUTED IN SQL, which is what keeps the internal enum
 * out of the UI and makes the wording changeable without an API change. It must
 * cover every status a report can reach — `not_a_plant` and `cancelled` were
 * missing when this was first written, and it mattered: a quorum-rejected report
 * ALSO has disqualifiedBy set, so two rows would have matched one report and a
 * community rejection would have rendered as "reviewed but not recorded".
 * `status = 'rejected'` therefore takes precedence and is tested FIRST.
 *
 * No claimer's name, no admin note, and voterCount only — never a voter id,
 * username or name. Disclosing the note would leak moderation reasoning to the
 * person being moderated; naming five accounts would leak identities the claim
 * path deliberately withholds.
 */
async function listMyDiscoveryReports(accountId, { page, pageSize } = {}) {
    const paging = parsePaging({ page, pageSize });

    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.status, ar.createdAt, ar.reviewedAt, ar.payload,
                ar.disqualifyReason, ar.targetPlantId,
                ar.disqualifiedBy, ar.recordRequestId,
                p.commonName AS targetCommonName,
                (SELECT COUNT(*) FROM discovery_votes v WHERE v.requestId = ar.requestId) AS voteCount,
                (SELECT di.imageId FROM discovery_images di WHERE di.requestId = ar.requestId
                  ORDER BY di.uploadedAt ASC, di.imageId ASC LIMIT 1) AS photoId
         FROM approval_requests ar
         LEFT JOIN plants p ON p.plantId = ar.targetPlantId
         WHERE ar.accountId = ? AND ar.requestType = ?
         ORDER BY ar.createdAt DESC
         LIMIT ? OFFSET ?`,
        [accountId, DISCOVERY_TYPE, paging.pageSize, paging.offset]
    );
    const [countRows] = await mysqlPool.query(
        'SELECT COUNT(*) AS total FROM approval_requests WHERE accountId = ? AND requestType = ?',
        [accountId, DISCOVERY_TYPE]
    );

    const reports = rows.map((r) => {
        const payload = parsePayload(r.payload);
        const state = discoveryState(r);
        return {
            requestId: r.requestId,
            submittedAt: r.createdAt,
            note: payload.note || null,
            location: payload.location || null,
            photoUrl: r.photoId
                ? `/api/discoveries/images/${encodeURIComponent(r.photoId)}`
                : null,
            state,
            reason: state === 'not_recorded' || state === 'not_a_plant'
                ? r.disqualifyReason || null
                : null,
            voterCount: Number(r.voteCount || 0),
            // ONE hop: targetPlantId is set when the record is approved, so the
            // reporter reaches the plant without resolving recordRequestId.
            plantUrl: state === 'added' && r.targetPlantId
                ? `/plant-profile.html?plantId=${encodeURIComponent(r.targetPlantId)}`
                : null,
            plantName: r.targetCommonName || null
        };
    });

    return {
        reports,
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize
    };
}

/** The seven states of in the order they must be tested. */
function discoveryState(row) {
    if (row.status === 'cancelled') return 'cancelled';
    if (row.status === 'rejected') return 'not_a_plant';
    if (row.status === 'approved') return 'added';
    if (row.status === 'denied') return 'not_added';
    if (row.disqualifiedBy) return 'not_recorded';
    if (row.recordRequestId) return 'recording';
    return 'waiting';
}

/**
 *  tells the report form its numbers BEFORE submission. Convenience only —
 * the server remains the authority, exactly as the client count is in the claim
 * cap.
 */
async function getMyDiscoverySummary(accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT COUNT(*) AS n FROM approval_requests
         WHERE accountId = ? AND requestType = ? AND status = 'pending'`,
        [accountId, DISCOVERY_TYPE]
    );
    const [lastRows] = await mysqlPool.query(
        `SELECT createdAt FROM approval_requests
         WHERE accountId = ? AND requestType = ?
         ORDER BY createdAt DESC LIMIT 1`,
        [accountId, DISCOVERY_TYPE]
    );
    return {
        open: Number(rows[0].n),
        limit: settings.discoveries.maxOpenReportsPerAccount,
        cooldownMinutes: settings.discoveries.reportCooldownMinutes,
        lastFiledAt: lastRows.length > 0 ? lastRows[0].createdAt : null
    };
}

/**
 *  the admin discovery queue, with its OWN mapper.
 *
 * Two mappers rather than one carrying three branches. plantName comes from the
 * top predicted species because a report genuinely has no plant of its own —
 * its targetPlantId is null until its record is approved — and falling back to
 * 'Unidentified plant' keeps the row shape the existing admin assertions expect.
 */
async function listDiscoveryReports({ status, page, pageSize } = {}) {
    const paging = parsePaging({ page, pageSize });
    const cutoff = staleClaimCutoff();
    const activeBotanists = await countActiveBotanists();
    const threshold = effectiveNotAPlantThreshold(activeBotanists);

    const where = ['ar.requestType = ?'];
    const params = [DISCOVERY_TYPE];
    // Defaults to pending, so a rejected report is ONE CLICK away in an audit
    // view. Rejection by committee with no oversight at all is a different
    // feature from "lessen the admin's queue".
    if (status) {
        where.push('ar.status = ?');
        params.push(status);
    } else {
        where.push("ar.status = 'pending'");
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.status, ar.createdAt, ar.reviewedAt, ar.payload, ar.note,
                ar.claimedBy, ar.claimedAt, ar.claimSource, ar.recordRequestId, ar.targetPlantId,
                ar.disqualifiedBy, ar.disqualifyReason,
                ar.reviewedBy, ar.approvalMode,
                a.accountId AS submitterId, a.username AS submitterName,
                pr.firstName AS submitterFirstName, pr.lastName AS submitterLastName,
                claimer.username AS claimerName,
                (SELECT COUNT(*) FROM discovery_votes v WHERE v.requestId = ar.requestId) AS voteCount
         FROM approval_requests ar
         JOIN accounts a ON a.accountId = ar.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         LEFT JOIN accounts claimer ON claimer.accountId = ar.claimedBy
         ${whereSql}
         ORDER BY ar.createdAt ASC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );
    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total FROM approval_requests ar ${whereSql}`,
        params
    );

    const imagesByRequest = await listDiscoveryImagesForRequests(rows.map((r) => r.requestId));

    return {
        requests: rows.map((r) => {
            const payload = parsePayload(r.payload);
            const predictions = Array.isArray(payload.predictions) ? payload.predictions : [];
            const top = predictions[0];
            const fullName = [r.submitterFirstName, r.submitterLastName].filter(Boolean).join(' ');
            return {
                id: r.requestId,
                requestType: DISCOVERY_TYPE,
                plantName: top ? (top.scientificName || top.commonName || 'Unidentified plant') : 'Unidentified plant',
                requestedAt: r.createdAt,
                submittedBy: r.submitterId,
                submittedByName: fullName || r.submitterName,
                note: payload.note || r.note || null,
                location: payload.location || null,
                predictions,
                // For a report, "has a description" means the reporter left a note.
                hasDescription: Boolean(payload.note),
                status: r.status,
                images: (imagesByRequest.get(r.requestId) || []).map((img) => ({
                    imageId: img.imageId,
                    url: `/admin/api/discovery-images/${encodeURIComponent(img.imageId)}`
                })),
                claimedBy: r.claimedBy,
                claimedByName: r.claimerName || null,
                claimedAt: r.claimedAt,
                claimSource: r.claimSource,
                recordRequestId: r.recordRequestId,
                targetPlantId: r.targetPlantId,
                disqualifiedBy: r.disqualifiedBy,
                disqualifyReason: r.disqualifyReason,
                // Who closed the report, and whether a human or the rule set did it.
                // A report closed by an automatically approved record carries the
                // SYSTEM account here, which is the point: the trigger was a
                // botanist pressing submit, the decider was the mode.
                reviewedBy: r.reviewedBy,
                approvalMode: r.approvalMode || 'manual',
                voteCount: Number(r.voteCount || 0),
                notAPlantThreshold: threshold,
                activeBotanists
            };
        }),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize,
        activeBotanists,
        notAPlantThreshold: threshold
    };
}

/**
 * the claim rule a botanist's plant submission must satisfy when it
 * carries a discoveryRequestId.
 *
 * The client hides the control behind "view only", but the client is not the
 * authority: without this, ANY botanist could attach a record to a report another
 * botanist is working on.
 *
 * It belongs in the transaction beside the claim validation rather than in
 * middleware: no middleware can know who holds the claim on a payload field.
 */
async function assertDiscoveryClaim(conn, discoveryRequestId, accountId) {
    if (!discoveryRequestId) return null;
    const [rows] = await conn.query(
        `SELECT claimedBy FROM approval_requests WHERE requestId = ? AND requestType = ?`,
        [discoveryRequestId, DISCOVERY_TYPE]
    );
    if (rows.length === 0) {
        return { error: 'Discovery report not found', code: 404 };
    }
    if (rows[0].claimedBy !== accountId) {
        return {
            error: rows[0].claimedBy
                ? 'Another botanist holds this discovery report'
                : 'You must claim this discovery report before recording it',
            code: 409
        };
    }
    return null;
}

/**
 * links the new record to the report that produced it, in the SAME
 * transaction as the insert, so a report can never point at a record that was
 * not created.
 *
 * Also clears the report's votes. Votes answer "is this even a plant?", and a
 * submitted description with measurements is a stronger claim to that question
 * than five opinions — so the veto dissolves against actual work rather than
 * accumulating across attempts. Clearing on SUBMIT is a separate mechanism from
 * the claim and not a replacement for it: dissent can only be dissolved by doing
 * the work, so a revise-denied resubmission starts the tally again at zero.
 */
async function linkDiscoveryRecord(conn, recordRequestId, discoveryRequestId) {
    await conn.query(
        'UPDATE approval_requests SET recordRequestId = ? WHERE requestId = ?',
        [recordRequestId, discoveryRequestId]
    );
    await conn.query('DELETE FROM discovery_votes WHERE requestId = ?', [discoveryRequestId]);
}

/**
 * purge the photos of every CLOSED report whose decision is
 * older than discoveryClosedPhotoDays.
 *
 * The row and its discovery_votes are kept indefinitely — they are the record of
 * what was decided and by whom — and the image is the most intrusive artefact and
 * the least necessary once that is written. `approved` is absent deliberately: an
 * approved report's photos became the plant's own approved images and are not
 * touched here.
 */
async function purgeClosedDiscoveryPhotos() {
    const cutoff = new Date(
        Date.now() - settings.discoveries.discoveryClosedPhotoDays * 24 * 60 * 60 * 1000
    );
    const conn = await mysqlPool.getConnection();
    let purgedRequests = 0;
    let removedFiles = 0;
    try {
        const [rows] = await conn.query(
            `SELECT ar.requestId, di.storedPath
             FROM approval_requests ar
             JOIN discovery_images di ON di.requestId = ar.requestId
             WHERE ar.requestType = ? AND ar.status IN ('denied','rejected')
               AND ar.reviewedAt IS NOT NULL AND ar.reviewedAt < ?`,
            [DISCOVERY_TYPE, cutoff]
        );
        const paths = rows.map((r) => r.storedPath);
        for (const relative of paths) {
            const destination = path.join(DISCOVERY_STORAGE_ROOT, relative);
            try {
                if (fs.existsSync(destination)) {
                    fs.unlinkSync(destination);
                    removedFiles++;
                }
            } catch (err) {
                console.error('Could not remove purged report photo:', err.message);
            }
        }
        const requestIds = [...new Set(rows.map((r) => r.requestId))];
        if (requestIds.length > 0) {
            // The rows go with the files, or the routes would keep handing out URLs
            // for bytes that no longer exist. The report itself survives.
            await conn.query(
                `DELETE FROM discovery_images WHERE requestId IN (${requestIds.map(() => '?').join(',')})`,
                requestIds
            );
            purgedRequests = requestIds.length;
        }
        for (const requestId of requestIds) removeEmptyDiscoveryFolders(requestId);
        return { purgedRequests, removedFiles };
    } finally {
        conn.release();
    }
}

/**
 * real claim expiry, not just an eligibility test.
 *
 * A claim older than claimStaleDays is ACTUALLY released, so a queue card never
 * shows a phantom claim. The predicate deliberately excludes any report that
 * already has a submitted record: an admin's decision outranks a staleness rule,
 * and a record under review is not "stale work" anyone should be handed.
 */
async function expireStaleDiscoveryClaims() {
    const cutoff = staleClaimCutoff();
    const conn = await mysqlPool.getConnection();
    try {
        const [rows] = await conn.query(
            `SELECT requestId, claimedBy FROM approval_requests
             WHERE requestType = ? AND claimedBy IS NOT NULL AND claimedAt IS NOT NULL
               AND claimedAt <= ? AND recordRequestId IS NULL`,
            [DISCOVERY_TYPE, cutoff]
        );
        if (rows.length === 0) return { expired: 0 };
        const [result] = await conn.query(
            `UPDATE approval_requests
             SET claimedBy = NULL, claimedAt = NULL, claimSource = 'manual'
             WHERE requestId IN (${rows.map(() => '?').join(',')})
               AND recordRequestId IS NULL`,
            rows.map((r) => r.requestId)
        );
        for (const row of rows) {
            await logImageReview({
                requestId: row.requestId,
                requestType: DISCOVERY_TYPE,
                imageId: null,
                plantId: null,
                accountId: row.claimedBy,
                decision: 'claim_expired',
                reviewedBy: '',
                note: `Claim older than ${settings.discoveries.claimStaleDays} days`
            });
        }
        return { expired: result.affectedRows };
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Scan quota (MySQL is authoritative: the counter must survive a restart)
// ---------------------------------------------------------------------------

/**
 * Start of the current fixed window, computed in JS so it cannot drift with the
 * pool timezone or a session-timezone change. windowStart is DATETIME, not
 * TIMESTAMP, for the same reason.
 */
function currentScanWindowStart(windowMs) {
    const size = windowMs || settings.ml.rateLimitWindowMs;
    return Math.floor(Date.now() / size) * size;
}

/** Whole seconds until the current window closes, at least 1. */
function scanWindowRetryAfterSeconds(windowMs) {
    const size = windowMs || settings.ml.rateLimitWindowMs;
    return Math.max(1, Math.ceil((size - (Date.now() % size)) / 1000));
}

/**
 * Charges one scan against the account's current window and returns the new
 * count. Charged on ATTEMPT, not on success, so a broken ML service cannot be
 * hammered; the caller's 502/504 paths still consume quota.
 *
 * FOR UPDATE serialises two simultaneous scans by the same account onto one
 * row. That is invisible at these limits and is not a reason to make the quota
 * approximate.
 */
async function consumeScanQuota(accountId, windowMs) {
    const windowStart = currentScanWindowStart(windowMs);
    // One value, one type, for all three statements. windowStart is DATETIME, so
    // a bare epoch number is compared as a numeric literal and silently never
    // matches the stored row: the SELECT would report "no row" every time and the
    // INSERT would then fail with a duplicate-key error that the route fails open
    // on. The quota would look enforced while charging nothing after the first
    // scan. windowStart = new Date(...) on its own is not a comparison a datetime
    // index can use either, hence both halves of this.
    const windowDate = new Date(windowStart);
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // Get roleId from account for per-role rate limit
        const [accountRows] = await conn.query('SELECT roleId FROM accounts WHERE accountId = ?', [accountId]);
        const roleId = accountRows[0]?.roleId;

        // Resolve rateLimitMax from role_limits -> system_settings -> settings.js
        let rateLimitMax;
        if (roleId) {
            const resolved = await resolveLimit(conn, 'rateLimitMax', roleId);
            rateLimitMax = typeof resolved === 'object' ? resolved.rateLimitMax : resolved;
        }
        if (!rateLimitMax) rateLimitMax = settings.ml.rateLimitMax;

        const [rows] = await conn.query(
            'SELECT scansUsed FROM ml_scan_usage WHERE accountId = ? AND windowStart = ? FOR UPDATE',
            [accountId, windowDate]
        );

        let used;
        if (rows.length === 0) {
            used = 1;
            await conn.query(
                'INSERT INTO ml_scan_usage (accountId, windowStart, scansUsed) VALUES (?, ?, 1)',
                [accountId, windowDate]
            );
        } else {
            used = rows[0].scansUsed + 1;
            await conn.query(
                'UPDATE ml_scan_usage SET scansUsed = ? WHERE accountId = ? AND windowStart = ?',
                [used, accountId, windowDate]
            );
        }

        await conn.commit();
        return { used, windowStart, windowEnd: windowStart + (windowMs || settings.ml.rateLimitWindowMs), limit: rateLimitMax };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/** Only plants that have an approved primary description are publicly visible. */
const PUBLIC_VISIBILITY = `EXISTS (
    SELECT 1 FROM plant_description pd
    WHERE pd.plantId = p.plantId AND pd.status = 'approved' AND pd.isPrimary = TRUE
)`;

async function listPublicPlants({ search, type, page, pageSize }) {
    const paging = parsePaging({ page, pageSize });
    const where = [PUBLIC_VISIBILITY];
    const params = [];

    if (search) {
        where.push("(p.commonName LIKE ? ESCAPE '\\\\' OR p.scientificName LIKE ? ESCAPE '\\\\')");
        const like = `%${escapeLike(search)}%`;
        params.push(like, like);
    }
    if (type) {
        where.push('t.typeName = ?');
        params.push(type);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.quantity,
                t.typeName, t.label AS typeLabel, t.icon AS typeIcon, t.badgeClass AS typeBadgeClass,
                t.isMedicinal, t.isHarmful, t.toxicityLevel, t.cautionNote,
                (SELECT i.imageId FROM plant_images i
                 WHERE i.plantId = p.plantId AND i.status = 'approved'
                 ORDER BY i.isPrimary DESC, i.uploadedAt ASC LIMIT 1) AS heroImageId
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         ${whereSql}
         ORDER BY p.commonName ASC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );

    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total FROM plants p JOIN plant_types t ON p.typeId = t.typeId ${whereSql}`,
        params
    );

    return {
        plants: rows.map((r) => ({
            id: r.plantId,
            name: r.commonName,
            scientificName: r.scientificName,
            quantity: r.quantity,
            type: r.typeName,
            typeLabel: r.typeLabel,
            typeIcon: r.typeIcon,
            typeBadgeClass: r.typeBadgeClass,
            isMedicinal: Boolean(r.isMedicinal),
            isHarmful: Boolean(r.isHarmful),
            toxicityLevel: r.toxicityLevel,
            cautionNote: r.cautionNote,
            imageUrl: r.heroImageId ? `/api/plants/${r.plantId}/images/${r.heroImageId}` : null
        })),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize
    };
}

async function getPublicPlantDetail(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.quantity, p.createdAt,
                t.typeName, t.label AS typeLabel, t.icon AS typeIcon, t.badgeClass AS typeBadgeClass,
                t.isMedicinal, t.isHarmful, t.toxicityLevel, t.cautionNote
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         WHERE p.plantId = ? AND ${PUBLIC_VISIBILITY}`,
        [plantId]
    );
    if (rows.length === 0) return null;
    const p = rows[0];

    const [images] = await mysqlPool.query(
        `SELECT imageId, originalFilename FROM plant_images
         WHERE plantId = ? AND status = 'approved'
         ORDER BY isPrimary DESC, uploadedAt ASC`,
        [plantId]
    );

    const [descriptions] = await mysqlPool.query(
        `SELECT d.descriptionId, d.uses, d.benefits, d.harmful, d.isPrimary, d.createdAt,
                a.accountId AS authorId, a.username AS authorName,
                pr.firstName, pr.lastName, pr.specialization,
                ${PARTS_SELECT}
         FROM plant_description d
         JOIN accounts a ON d.accountId = a.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         -- LEFT JOIN, not INNER: a description without measurements must still
         -- be listed, it just reports parts: null.
         LEFT JOIN plant_parts pp ON d.partsId = pp.partId
         WHERE d.plantId = ? AND d.status = 'approved'
         ORDER BY d.isPrimary DESC, d.createdAt ASC`,
        [plantId]
    );

    const summary = await getContributorSummary(plantId);

    return {
        id: p.plantId,
        name: p.commonName,
        scientificName: p.scientificName,
        quantity: p.quantity,
        type: p.typeName,
        typeLabel: p.typeLabel,
        typeIcon: p.typeIcon,
        typeBadgeClass: p.typeBadgeClass,
        isMedicinal: Boolean(p.isMedicinal),
        isHarmful: Boolean(p.isHarmful),
        toxicityLevel: p.toxicityLevel,
        cautionNote: p.cautionNote,
        createdAt: p.createdAt,
        images: images.map((i) => ({
            imageId: i.imageId,
            imageUrl: `/api/plants/${plantId}/images/${i.imageId}`,
            originalFilename: i.originalFilename
        })),
        descriptions: descriptions.map((d) => ({
            descriptionId: d.descriptionId,
            isPrimary: Boolean(d.isPrimary),
            uses: d.uses,
            benefits: d.benefits,
            harmful: d.harmful,
            author: {
                accountId: d.authorId,
                name: [d.firstName, d.lastName].filter(Boolean).join(' ') || d.authorName,
                specialization: d.specialization
            },
            parts: partsFromRow(d),
            createdAt: d.createdAt
        })),
        recordedBy: summary.recordedBy,
        reviewedBy: summary.reviewedBy,
        //  A plant can carry "Reported By: <user>, Recorded By: <botanist>"
        // with no ambiguity about who wrote what.
        reportedBy: summary.reportedBy
    };
}

async function getBotanistProfile(accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT a.accountId, a.username, a.createdAt, r.roleName,
                pr.firstName, pr.lastName, pr.bio, pr.specialization
         FROM accounts a
         JOIN roles r ON a.roleId = r.roleId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         WHERE a.accountId = ?`,
        [accountId]
    );
    if (rows.length === 0) return null;
    const a = rows[0];

    // reviewedCount stays reviewer-only, and reportedCount is a SEPARATE column
    // for role = 'reporter' — not folded into reviewedCount, and never added to a
    // "contributed" figure. They are different claims and must not blur.
    const [stats] = await mysqlPool.query(
        `SELECT COUNT(DISTINCT pc.plantId) AS plantCount,
                COALESCE(SUM(CASE WHEN pc.role = 'reviewer' THEN 1 ELSE 0 END), 0) AS reviewedCount,
                COALESCE(SUM(CASE WHEN pc.role = 'reporter' THEN 1 ELSE 0 END), 0) AS reportedCount
         FROM plant_contributors pc
         WHERE pc.accountId = ?`,
        [accountId]
    );

    // The verified-contributions grid filters to role = 'contributor'. Without
    // that filter a reported species would render under "No verified
    // contributions yet" as though the reporter had verified it. Filtering is not
    // enough on its own, which is why there is a separate Reported grid below.
    //
    // Both queries are INLINE here — there is no listContributorPlants or
    // getContributorStats function to edit, and a fresh one would omit the
    // PUBLIC_VISIBILITY guard, which is exactly what keeps an unapproved plant off
    // a profile.
    const contributionSelect = `
        SELECT p.plantId, p.commonName, p.scientificName, pc.role, pc.createdAt,
                t.typeName, t.label AS typeLabel,
                (SELECT i.imageId FROM plant_images i
                 WHERE i.plantId = p.plantId AND i.status = 'approved'
                 ORDER BY i.isPrimary DESC, i.uploadedAt ASC LIMIT 1) AS heroImageId
        FROM plant_contributors pc
        JOIN plants p ON pc.plantId = p.plantId
        JOIN plant_types t ON p.typeId = t.typeId`;
    const orderAndVisibility = `
        ORDER BY pc.createdAt DESC`;

    const [contributions] = await mysqlPool.query(
        `${contributionSelect}
         WHERE pc.accountId = ? AND pc.role = 'contributor' AND ${PUBLIC_VISIBILITY}
         ${orderAndVisibility}`,
        [accountId]
    );

    const [reported] = await mysqlPool.query(
        `${contributionSelect}
         WHERE pc.accountId = ? AND pc.role = 'reporter' AND ${PUBLIC_VISIBILITY}
         ${orderAndVisibility}`,
        [accountId]
    );

    return {
        accountId: a.accountId,
        name: [a.firstName, a.lastName].filter(Boolean).join(' ') || a.username,
        username: a.username,
        role: a.roleName,
        bio: a.bio,
        specialization: a.specialization,
        joinedAt: a.createdAt,
        metrics: {
            verifiedPlants: stats[0].plantCount,
            reviewedPlants: stats[0].reviewedCount,
            reportedPlants: Number(stats[0].reportedCount || 0)
        },
        contributions: contributions.map((c) => ({
            id: c.plantId,
            name: c.commonName,
            scientificName: c.scientificName,
            role: c.role,
            type: c.typeName,
            typeLabel: c.typeLabel,
            imageUrl: c.heroImageId ? `/api/plants/${c.plantId}/images/${c.heroImageId}` : null
        })),
        // A separate grid over role = 'reporter', same joins and the same
        // PUBLIC_VISIBILITY guard. Showing the distinction to a reader is better
        // than silently hiding it.
        reported: reported.map((c) => ({
            id: c.plantId,
            name: c.commonName,
            scientificName: c.scientificName,
            role: c.role,
            type: c.typeName,
            typeLabel: c.typeLabel,
            imageUrl: c.heroImageId ? `/api/plants/${c.plantId}/images/${c.heroImageId}` : null
        }))
    };
}

async function listPlantTypes() {
    const [rows] = await mysqlPool.query(
        `SELECT typeId, typeName, label, icon, badgeClass, isMedicinal, isHarmful, toxicityLevel, cautionNote
         FROM plant_types ORDER BY label ASC`
    );
    return rows.map((r) => ({
        typeId: r.typeId,
        typeName: r.typeName,
        label: r.label,
        icon: r.icon,
        badgeClass: r.badgeClass,
        isMedicinal: Boolean(r.isMedicinal),
        isHarmful: Boolean(r.isHarmful),
        toxicityLevel: r.toxicityLevel,
        cautionNote: r.cautionNote
    }));
}

/** Maps ML class names to plant rows, for scan-result linking. */
async function resolveScientificNames(names) {
    if (!names.length) return new Map();
    const placeholders = names.map(() => '?').join(',');
    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.scientificName, p.commonName,
                (SELECT i.imageId FROM plant_images i
                 WHERE i.plantId = p.plantId AND i.status = 'approved'
                 ORDER BY i.isPrimary DESC, i.uploadedAt ASC LIMIT 1) AS heroImageId
         FROM plants p WHERE p.scientificName IN (${placeholders})`,
        names
    );
    return new Map(rows.map((r) => [r.scientificName, r]));
}

/** Species present in the database, in classes.json, or both. */
async function getMlCoverage(classes) {
    const [rows] = await mysqlPool.query(
        `SELECT DISTINCT p.scientificName FROM plants p
         JOIN plant_images i ON i.plantId = p.plantId AND i.status = 'approved'`
    );
    const plantNames = new Set(rows.map((r) => r.scientificName));
    const classNames = new Set(classes.map((c) => c.scientific));
    return {
        matched: [...plantNames].filter((n) => classNames.has(n)),
        plantsOnly: [...plantNames].filter((n) => !classNames.has(n)),
        classesOnly: [...classNames].filter((n) => !plantNames.has(n))
    };
}

/**
 * Every species somebody has already filed a discovery report about, by name.
 *
 * The gap aggregation runs in Mongo and these names live in MySQL, so
 * they have to cross over — which means this endpoint now depends on BOTH
 * databases, and the failure mode to avoid is specific: a MySQL error that
 * returns an UNFILTERED list is indistinguishable from a working card, and it
 * fills the dashboard with species the team already handled. So this THROWS on
 * failure rather than returning an empty array, and the caller turns a throw into
 * `degraded: true` with no rows. An empty array would silently disable the filter
 * and look like a healthy answer.
 *
 * EVERY plant_discovery request counts, whatever its status. A report that was
 * rejected as not-a-plant, withdrawn, or closed by the quorum has all been
 * adjudicated, and re-listing the species is how a signal gets ignored. Only
 * reports that have never been decided are work in progress, and `reported` on the
 * scan feed  already covers the overlap for reports filed
 * straight from a scan.
 *
 * `executor` is a parameter rather than the pool so the failing branch is
 * reachable from a test with a deliberately broken executor, rather than only by
 * breaking a live table.
 */
async function listHandledDiscoverySpecies(executor = mysqlPool) {
    const [rows] = await executor.query(
        `SELECT DISTINCT jt.scientificName
         FROM approval_requests ar
         JOIN JSON_TABLE(
             ar.payload, '$.predictions[*]' COLUMNS (
                 scientificName VARCHAR(255) PATH '$.scientificName'
             )
         ) AS jt
         WHERE ar.requestType = ?
           AND ar.payload IS NOT NULL
           AND jt.scientificName IS NOT NULL
           AND jt.scientificName <> ''`,
        [DISCOVERY_TYPE]
    );
    return rows.map((r) => r.scientificName).filter(Boolean);
}

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
    mysqlPool,
    parsePaging,
    getPermissionsVersion,
    getSessionGuard,
    loadAccountPermissions,
    bumpPermissionsVersion,
    getPrivilegedRoleIds,
    countActiveSuperadmins,
    insertCertificate,
    insertRoleRequest,
    recordConsent,
    getConsentState,
    listUsers,
    setAccountStatus,
    changeAccountRole,
    listPendingRoleRequests,
    listPlantRequests,
    getRequestDetail,
    decideRoleRequest,
    listPlants,
    getContributorSummary,
    getPlantDetailSummary,
    listPlantImages,
    getImageForServing,
    getImageForReview,
    getImageForOwner,
    getPlantExists,
    approvePlantRequest,
    denyPlantRequest,
    validatePlantDraft,
    validateContribution,
    createPlantAdditionRequest,
    createPlantContributionRequest,
    listMyRequests,

    // ---- automatic approval (document 3) ----
    hasPriorSubmissionDecision,
    maybeAutoResolve,
    processNewRequest,

    // ---- discovery loop ----
    DISCOVERY_TYPE,
    DISQUALIFY_REASONS,
    DENIAL_KINDS,
    DISCOVERY_STORAGE_ROOT,
    countActiveBotanists,
    effectiveNotAPlantThreshold,
    getDiscoveryFeatureFlag,
    isAutoDispatchEnabled,
    createDiscoveryReport,
    getDiscoveryImageForOwner,
    getDiscoveryImageForBotanist,
    getDiscoveryImageForReview,
    listPendingDiscoveries,
    getDiscoveryCounts,
    claimDiscovery,
    unclaimDiscovery,
    releaseDiscovery,
    resolveDiscovery,
    reopenDiscovery,
    disqualifyDiscovery,
    reinstateDisqualified,
    castNotAPlantVote,
    countNotAPlantVotes,
    listNotAPlantVoters,
    adminDisqualifyDiscovery,
    cancelDiscoveryReport,
    listMyDiscoveryReports,
    getMyDiscoverySummary,
    listDiscoveryReports,
    purgeClosedDiscoveryPhotos,
    expireStaleDiscoveryClaims,

    currentScanWindowStart,
    scanWindowRetryAfterSeconds,
    consumeScanQuota,
    listPublicPlants,
    getPublicPlantDetail,
    getBotanistProfile,
    listPlantTypes,
    resolveScientificNames,
    getMlCoverage,
    listHandledDiscoverySpecies,
    getSystemSetting,
    listCertificatesByAccount,
    deleteCertificate
};
