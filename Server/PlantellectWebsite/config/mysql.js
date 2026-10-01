require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const settings = require('./settings');
const { insertRow, nextKey } = require('./ids.js');

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
             FROM accounts a JOIN roles r ON a.roleId = r.roleId
             WHERE a.accountId = ? FOR UPDATE`,
            [accountId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Account not found', code: 404 };
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
 */
async function changeAccountRole(accountId, newRoleName, actorPermissions, actorAccountId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [targetRows] = await conn.query(
            `SELECT a.roleId, r.roleName
             FROM accounts a JOIN roles r ON a.roleId = r.roleId
             WHERE a.accountId = ? FOR UPDATE`,
            [accountId]
        );
        if (targetRows.length === 0) {
            await conn.rollback();
            return { error: 'Account not found', code: 404 };
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

async function finishRequest(conn, requestId, status, reviewerId, note) {
    await conn.query(
        'UPDATE approval_requests SET status = ?, reviewedBy = ?, reviewedAt = NOW(), note = ? WHERE requestId = ?',
        [status, reviewerId, note || null, requestId]
    );
}

async function reviewRoleRequest(conn, requestId, reviewerId, status, note) {
    await finishRequest(conn, requestId, status, reviewerId, note);
}

// ---------------------------------------------------------------------------
// Admin: plants
// ---------------------------------------------------------------------------

const CONTRIBUTOR_LIST_LENGTH = 120;

/**
 * Paginated plant inventory. Recorded By and Reviewed By are GROUP_CONCATs of
 * plant_contributors, truncated so one busy plant cannot blow up the payload.
 */
async function listPlants({ search, type, page, pageSize }) {
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
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.quantity, p.createdAt,
                t.typeName, t.label AS typeLabel, t.icon AS typeIcon, t.badgeClass AS typeBadgeClass,
                (SELECT COUNT(*) FROM plant_images i WHERE i.plantId = p.plantId AND i.status = 'approved') AS imageCount,
                (SELECT COUNT(*) FROM plant_images i WHERE i.plantId = p.plantId AND i.status = 'pending') AS pendingImageCount,
                (SELECT COUNT(*) FROM plant_description d WHERE d.plantId = p.plantId AND d.status = 'approved') AS descriptionCount
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         ${whereSql}
         ORDER BY p.createdAt DESC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );

    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total FROM plants p JOIN plant_types t ON p.typeId = t.typeId ${whereSql}`,
        params
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
            ...(await getContributorSummary(row.plantId)),
            ...(await getPlantDetailSummary(row.plantId))
        });
    }

    return { plants, total: countRows[0].total, page: paging.page, pageSize: paging.pageSize };
}

async function getContributorSummary(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT pc.role, GROUP_CONCAT(DISTINCT COALESCE(NULLIF(CONCAT(p.firstName, ' ', p.lastName), ' '), a.username)
                    ORDER BY pc.createdAt SEPARATOR ', ') AS names
         FROM plant_contributors pc
         JOIN accounts a ON pc.accountId = a.accountId
         LEFT JOIN profiles p ON p.accountId = a.accountId
         WHERE pc.plantId = ?
         GROUP BY pc.role`,
        [plantId]
    );
    const summary = { recordedBy: [], reviewedBy: [] };
    for (const row of rows) {
        const names = row.names || '';
        if (!names) continue;
        const parts = names.split(', ');
        const shown = parts.slice(0, 3).join(', ');
        const overflow = parts.length > 3 ? ` +${parts.length - 3} more` : '';
        const label = (shown + overflow).slice(0, CONTRIBUTOR_LIST_LENGTH);
        if (row.role === 'contributor') summary.recordedBy.push(label);
        if (row.role === 'reviewer') summary.reviewedBy.push(label);
    }
    return { recordedBy: summary.recordedBy.join('; '), reviewedBy: summary.reviewedBy.join('; ') };
}

async function getPlantDetailSummary(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT d.uses, d.benefits, d.harmful,
                pp.heightMinCm, pp.heightMaxCm, pp.heightNote,
                pp.widthMinCm, pp.widthMaxCm, pp.widthNote,
                pp.color, pp.shape, pp.texture
         FROM plant_description d
         JOIN plant_parts pp ON d.partsId = pp.partId
         WHERE d.plantId = ? AND d.status = 'approved' AND d.isPrimary = TRUE
         LIMIT 1`,
        [plantId]
    );
    if (rows.length === 0) return { parts: null, description: null };
    const r = rows[0];
    return {
        parts: {
            heightMinCm: r.heightMinCm, heightMaxCm: r.heightMaxCm, heightNote: r.heightNote,
            widthMinCm: r.widthMinCm, widthMaxCm: r.widthMaxCm, widthNote: r.widthNote,
            color: r.color, shape: r.shape, texture: r.texture
        },
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

        const payload = parsePayload(request.payload);
        const submitterId = request.accountId;
        let plantId = request.targetPlantId;
        let converted = false;
        let noteText = note || null;

        if (request.requestType === 'plant_addition') {
            const [existing] = await conn.query(
                'SELECT plantId FROM plants WHERE scientificName = ? FOR UPDATE',
                [payload.scientificName]
            );
            if (existing.length > 0) {
                plantId = existing[0].plantId;
                converted = true;
                noteText = note
                    ? `${note}\n\n[system] This species already existed as ${plantId}; the submission was attached to it.`
                    : `[system] This species already existed as ${plantId}; the submission was attached to it.`;
            } else {
                const taxonomyId = await insertRow(
                    conn,
                    'taxonomy',
                    ['kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'],
                    [
                        payload.kingdom || 'Plantae',
                        payload.phylum || 'Tracheophyta',
                        payload.plantClass || payload.class || 'Magnoliopsida',
                        payload.order || 'Lamiales',
                        payload.family || 'Lamiaceae',
                        payload.genus || (payload.commonName || 'Unknown'),
                        payload.species || (payload.scientificName || 'Unknown')
                    ]
                );
                plantId = await insertRow(
                    conn,
                    'plants',
                    ['taxonomyId', 'typeId', 'commonName', 'scientificName', 'quantity'],
                    [taxonomyId, payload.typeId, payload.commonName, payload.scientificName, payload.quantity ?? null]
                );
            }
        }

        if (!plantId) {
            await conn.rollback();
            return { error: 'Request has no resolvable plant', code: 400 };
        }

        // Parts: either the draft's measurements or a contribution's upload.
        const parts = payload.parts || {};
        const hasParts = Object.values(parts).some((v) => v !== null && v !== undefined && v !== '');
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
        const hasDescription = payload.uses || payload.benefits || payload.harmful;
        if (hasDescription && partsId) {
            await insertRow(
                conn,
                'plant_description',
                ['plantId', 'accountId', 'partsId', 'uses', 'benefits', 'harmful', 'status', 'isPrimary', 'reviewedBy', 'reviewedAt'],
                [plantId, submitterId, partsId, payload.uses ?? null, payload.benefits ?? null, payload.harmful ?? null,
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
        await ensurePrimaryContent(conn, plantId);
        await finishRequest(conn, requestId, 'approved', reviewerId, noteText);

        await conn.commit();
        return { requestId, plantId, converted };
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
 */
async function denyPlantRequest(requestId, reviewerId, note) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const request = await claimPendingRequest(conn, requestId);
        if (!request) {
            await conn.rollback();
            return { error: 'Request is not pending or does not exist', code: 409 };
        }

        const payload = parsePayload(request.payload);
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

        await finishRequest(conn, requestId, 'denied', reviewerId, note);
        await conn.commit();
        return { requestId };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Botanist submissions
// ---------------------------------------------------------------------------

/** Validates a new-plant draft. Duplicate species is allowed on purpose. */
function validatePlantDraft(body) {
    const errors = [];
    if (!body.commonName || !String(body.commonName).trim()) errors.push('commonName is required');
    if (!body.scientificName || !String(body.scientificName).trim()) errors.push('scientificName is required');
    if (!body.typeId) errors.push('typeId is required');
    if (body.quantity !== undefined && body.quantity !== null && body.quantity !== '' && Number.isNaN(Number(body.quantity))) {
        errors.push('quantity must be a number');
    }
    const parts = body.parts || {};
    for (const key of ['heightMinCm', 'heightMaxCm', 'widthMinCm', 'widthMaxCm']) {
        if (parts[key] !== undefined && parts[key] !== null && parts[key] !== '' && Number.isNaN(Number(parts[key]))) {
            errors.push(`parts.${key} must be a number`);
        }
    }
    if (parts.heightMinCm != null && parts.heightMaxCm != null && Number(parts.heightMinCm) > Number(parts.heightMaxCm)) {
        errors.push('parts.heightMinCm cannot exceed heightMaxCm');
    }
    if (parts.widthMinCm != null && parts.widthMaxCm != null && Number(parts.widthMinCm) > Number(parts.widthMaxCm)) {
        errors.push('parts.widthMinCm cannot exceed widthMaxCm');
    }
    return errors;
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

/** Creates the plant_addition request; the draft stays in `payload` only. */
async function createPlantAdditionRequest(accountId, draft) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
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
    try {
        await conn.beginTransaction();

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
            fs.renameSync(file.path, path.join(settings.plantImages.storageDir, relativePath));
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

        await conn.commit();
        return { requestId, imageIds };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** The caller's own submissions and where each one stands. */
async function listMyRequests(accountId, { page, pageSize } = {}) {
    const paging = parsePaging({ page, pageSize });
    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.requestType, ar.status, ar.targetPlantId, ar.note, ar.createdAt, ar.reviewedAt,
                ar.reviewedBy,
                p.commonName AS targetCommonName,
                rev.username AS reviewerName
         FROM approval_requests ar
         LEFT JOIN plants p ON ar.targetPlantId = p.plantId
         LEFT JOIN accounts rev ON ar.reviewedBy = rev.accountId
         WHERE ar.accountId = ?
         ORDER BY ar.createdAt DESC
         LIMIT ? OFFSET ?`,
        [accountId, paging.pageSize, paging.offset]
    );
    const [countRows] = await mysqlPool.query(
        'SELECT COUNT(*) AS total FROM approval_requests WHERE accountId = ?',
        [accountId]
    );
    return {
        requests: rows.map((r) => ({
            id: r.requestId,
            requestType: r.requestType,
            status: r.status,
            targetPlantId: r.targetPlantId,
            targetPlantName: r.targetCommonName,
            note: r.note,
            createdAt: r.createdAt,
            reviewedAt: r.reviewedAt,
            reviewerName: r.reviewerName
        })),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize
    };
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
                pp.heightMinCm, pp.heightMaxCm, pp.heightNote,
                pp.widthMinCm, pp.widthMaxCm, pp.widthNote,
                pp.color, pp.shape, pp.texture
         FROM plant_description d
         JOIN accounts a ON d.accountId = a.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         JOIN plant_parts pp ON d.partsId = pp.partId
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
            parts: {
                heightMinCm: d.heightMinCm, heightMaxCm: d.heightMaxCm, heightNote: d.heightNote,
                widthMinCm: d.widthMinCm, widthMaxCm: d.widthMaxCm, widthNote: d.widthNote,
                color: d.color, shape: d.shape, texture: d.texture
            },
            createdAt: d.createdAt
        })),
        recordedBy: summary.recordedBy,
        reviewedBy: summary.reviewedBy
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

    const [stats] = await mysqlPool.query(
        `SELECT COUNT(DISTINCT pc.plantId) AS plantCount,
                COALESCE(SUM(CASE WHEN pc.role = 'reviewer' THEN 1 ELSE 0 END), 0) AS reviewedCount
         FROM plant_contributors pc
         WHERE pc.accountId = ?`,
        [accountId]
    );

    const [contributions] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, pc.role, pc.createdAt,
                t.typeName, t.label AS typeLabel,
                (SELECT i.imageId FROM plant_images i
                 WHERE i.plantId = p.plantId AND i.status = 'approved'
                 ORDER BY i.isPrimary DESC, i.uploadedAt ASC LIMIT 1) AS heroImageId
         FROM plant_contributors pc
         JOIN plants p ON pc.plantId = p.plantId
         JOIN plant_types t ON p.typeId = t.typeId
         WHERE pc.accountId = ? AND ${PUBLIC_VISIBILITY.replace(/\bp\./g, 'p.')}
         ORDER BY pc.createdAt DESC`,
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
            reviewedPlants: stats[0].reviewedCount
        },
        contributions: contributions.map((c) => ({
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
        `SELECT p.plantId, p.scientificName,
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
    reviewRoleRequest,
    listPlants,
    getContributorSummary,
    getPlantDetailSummary,
    listPlantImages,
    getImageForServing,
    getImageForReview,
    getPlantExists,
    approvePlantRequest,
    denyPlantRequest,
    validatePlantDraft,
    validateContribution,
    createPlantAdditionRequest,
    createPlantContributionRequest,
    listMyRequests,
    listPublicPlants,
    getPublicPlantDetail,
    getBotanistProfile,
    listPlantTypes,
    resolveScientificNames,
    getMlCoverage,
    listCertificatesByAccount,
    deleteCertificate
};
