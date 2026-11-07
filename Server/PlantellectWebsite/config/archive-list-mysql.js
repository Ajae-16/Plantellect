// Reads for the Archive page (admin) and for "what happened to my plant / photo / description" (the user who
// uploaded it). Nothing here writes.
//
// The unit of the Archive page is the PLANT, shown like the plant library: one row per plant that has anything
// in the archive, which opens to its pieces (photos and descriptions). A plant is on the page when
//   - the plant itself is archived or deleted, or
//   - one of its photos or descriptions is archived or deleted (the plant stays active and public; the row
//     is only the main plant the piece belongs to).
// Opening a row of an ACTIVE plant lists only its archived / deleted pieces. Opening a row of an ARCHIVED or
// DELETED plant lists ALL its pieces, so each one can be deleted (or restored) on its own, exactly like the
// pieces in the plant library, whatever the state of the plant itself.
//
// Status words (config/archive-status.js): active | archived | deleted. A deleted item shows purgeAt (when it
// is removed for good) and daysLeft, from the retention days in Settings.
//
// The reason an admin typed is shown on the ADMIN reads only; the user-facing read never includes it.

const { mysqlPool } = require('./pool-mysql');
const archiveRetention = require('./archive-retention');
const { stateOf, describeStatus, effectiveStatus } = require('./archive-status');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_SIZE_DEFAULT = 10;
const PAGE_SIZE_MAX = 50;
const EXCERPT_LENGTH = 160;
const MINE_LIMIT = 200;

const STATUS_FILTERS = ['all', 'plants', 'pieces', 'deleted'];

const fail = (error, code = 400) => ({ error, code });

const person = (alias) => `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', ${alias}pr.firstName, ${alias}pr.lastName)), ''), ${alias}a.username)`;

// A plant is "in the archive" when it, or one of its approved photos or descriptions, is archived.
const INVOLVED_SQL = `(p.archivedAt IS NOT NULL
    OR EXISTS (SELECT 1 FROM plant_images xi WHERE xi.plantId = p.plantId AND xi.status = 'approved' AND xi.archivedAt IS NOT NULL)
    OR EXISTS (SELECT 1 FROM plant_description xd WHERE xd.plantId = p.plantId AND xd.status = 'approved' AND xd.archivedAt IS NOT NULL))`;

const DELETED_PIECE_SQL = `(p.deletedAt IS NOT NULL
    OR EXISTS (SELECT 1 FROM plant_images xi WHERE xi.plantId = p.plantId AND xi.status = 'approved' AND xi.deletedAt IS NOT NULL)
    OR EXISTS (SELECT 1 FROM plant_description xd WHERE xd.plantId = p.plantId AND xd.status = 'approved' AND xd.deletedAt IS NOT NULL))`;

function filterSql(status) {
    switch (status) {
        // Archived plants (not yet deleted), with everything in them.
        case 'plants': return 'p.archivedAt IS NOT NULL AND p.deletedAt IS NULL';
        // Active plants that only have archived or deleted pieces.
        case 'pieces': return 'p.archivedAt IS NULL';
        // Anything waiting for its retention days to pass.
        case 'deleted': return DELETED_PIECE_SQL;
        default: return '1 = 1';
    }
}

function paging(page, pageSize) {
    const size = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(pageSize, 10) || PAGE_SIZE_DEFAULT));
    const number = Math.max(1, parseInt(page, 10) || 1);
    return { page: number, pageSize: size, offset: (number - 1) * size };
}

const escapeLike = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);

const excerpt = (row) => {
    const text = [row.uses, row.benefits, row.harmful].filter(Boolean).join(' / ').replace(/\s+/g, ' ').trim();
    return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}\u2026` : text;
};

// ---------------------------------------------------------------------------
// Admin: the Archive page
// ---------------------------------------------------------------------------

/** Totals for the tiles at the top of the Archive page, plus the retention days in force. */
async function getArchiveSummary(deps = {}) {
    const db = deps.db || mysqlPool;
    const retentionDays = await archiveRetention.getRetentionDays(db);
    const count = async (sql) => Number(((await db.query(sql))[0][0] || {}).n) || 0;
    return {
        retentionDays,
        plants: {
            archived: await count('SELECT COUNT(*) AS n FROM plants WHERE archivedAt IS NOT NULL AND deletedAt IS NULL'),
            deleted: await count('SELECT COUNT(*) AS n FROM plants WHERE deletedAt IS NOT NULL')
        },
        photos: {
            archived: await count("SELECT COUNT(*) AS n FROM plant_images WHERE status = 'approved' AND archivedAt IS NOT NULL AND deletedAt IS NULL"),
            deleted: await count("SELECT COUNT(*) AS n FROM plant_images WHERE status = 'approved' AND deletedAt IS NOT NULL")
        },
        descriptions: {
            archived: await count("SELECT COUNT(*) AS n FROM plant_description WHERE status = 'approved' AND archivedAt IS NOT NULL AND deletedAt IS NULL"),
            deleted: await count("SELECT COUNT(*) AS n FROM plant_description WHERE status = 'approved' AND deletedAt IS NOT NULL")
        }
    };
}

/**
 * One page of the plants that are in the archive. options: { status, search, page, pageSize }.
 * status: all | plants | pieces | deleted (see filterSql).
 */
async function listArchivePlants(options = {}, deps = {}) {
    const db = deps.db || mysqlPool;
    const status = STATUS_FILTERS.includes(options.status) ? options.status : 'all';
    const { page, pageSize, offset } = paging(options.page, options.pageSize);
    const where = [INVOLVED_SQL, filterSql(status)];
    const params = [];
    const search = typeof options.search === 'string' ? options.search.trim() : '';
    if (search) {
        const like = `%${escapeLike(search)}%`;
        where.push("(p.commonName LIKE ? ESCAPE '\\\\' OR p.scientificName LIKE ? ESCAPE '\\\\')");
        params.push(like, like);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const retentionDays = await archiveRetention.getRetentionDays(db);

    const [rows] = await db.query(
        `SELECT p.plantId, p.commonName, p.scientificName, t.typeName, t.toxicityLevel,
                p.archivedAt, p.archiveReason, p.deletedAt,
                ${person('ab_')} AS archivedByName,
                ${person('db_')} AS deletedByName,
                (SELECT GROUP_CONCAT(DISTINCT ${person('c_')} ORDER BY c_a.username SEPARATOR ', ')
                   FROM plant_contributors c_pc
                   JOIN accounts c_a ON c_a.accountId = c_pc.accountId
                   LEFT JOIN profiles c_pr ON c_pr.accountId = c_a.accountId
                  WHERE c_pc.plantId = p.plantId AND c_pc.role = 'contributor') AS recordedBy,
                (SELECT COUNT(*) FROM plant_images i WHERE i.plantId = p.plantId AND i.status = 'approved') AS photosTotal,
                (SELECT COUNT(*) FROM plant_images i WHERE i.plantId = p.plantId AND i.status = 'approved' AND i.archivedAt IS NOT NULL AND i.deletedAt IS NULL) AS photosArchived,
                (SELECT COUNT(*) FROM plant_images i WHERE i.plantId = p.plantId AND i.status = 'approved' AND i.deletedAt IS NOT NULL) AS photosDeleted,
                (SELECT COUNT(*) FROM plant_description d WHERE d.plantId = p.plantId AND d.status = 'approved') AS descriptionsTotal,
                (SELECT COUNT(*) FROM plant_description d WHERE d.plantId = p.plantId AND d.status = 'approved' AND d.archivedAt IS NOT NULL AND d.deletedAt IS NULL) AS descriptionsArchived,
                (SELECT COUNT(*) FROM plant_description d WHERE d.plantId = p.plantId AND d.status = 'approved' AND d.deletedAt IS NOT NULL) AS descriptionsDeleted
         FROM plants p
         JOIN plant_types t ON t.typeId = p.typeId
         LEFT JOIN accounts ab_a ON ab_a.accountId = p.archivedBy
         LEFT JOIN profiles ab_pr ON ab_pr.accountId = ab_a.accountId
         LEFT JOIN accounts db_a ON db_a.accountId = p.deletedBy
         LEFT JOIN profiles db_pr ON db_pr.accountId = db_a.accountId
         ${whereSql}
         ORDER BY (p.deletedAt IS NOT NULL) DESC, COALESCE(p.deletedAt, p.archivedAt, p.updatedAt) DESC, p.commonName ASC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
    );
    const [counted] = await db.query(`SELECT COUNT(*) AS total FROM plants p ${whereSql}`, params);

    const now = new Date();
    return {
        retentionDays,
        total: Number(counted[0].total) || 0,
        page,
        pageSize,
        status,
        plants: rows.map((r) => ({
            id: r.plantId,
            name: r.commonName,
            scientificName: r.scientificName,
            type: r.typeName,
            toxicityLevel: r.toxicityLevel,
            recordedBy: r.recordedBy || '',
            plant: {
                ...describeStatus(r, retentionDays, now),
                archiveReason: r.archiveReason || null,
                archivedByName: r.archivedByName || null,
                deletedByName: r.deletedByName || null
            },
            counts: {
                photos: { total: Number(r.photosTotal), archived: Number(r.photosArchived), deleted: Number(r.photosDeleted) },
                descriptions: {
                    total: Number(r.descriptionsTotal), archived: Number(r.descriptionsArchived), deleted: Number(r.descriptionsDeleted)
                }
            }
        }))
    };
}

/**
 * The pieces of one plant for its opened row. See the head of this file for which pieces are listed.
 * Returns { plant, scope, photos, descriptions, retentionDays } or { error, code }.
 * `actions` on a piece says what the page may offer: restore (unarchive), delete, undoDelete.
 */
async function getArchivePieces(plantId, deps = {}) {
    if (!SAFE_ID.test(String(plantId || ''))) return fail('That is not a valid plant id');
    const db = deps.db || mysqlPool;
    const [plants] = await db.query(
        `SELECT p.plantId, p.commonName, p.archivedAt, p.archiveReason, p.deletedAt
         FROM plants p WHERE p.plantId = ?`,
        [plantId]
    );
    if (plants.length === 0) return fail('Plant not found', 404);
    const p = plants[0];
    const retentionDays = await archiveRetention.getRetentionDays(db);
    const now = new Date();
    const plantState = stateOf(p);
    // An archived or deleted plant shows every piece; an active one only the pieces that were archived.
    const all = plantState !== 'active';

    const [photoRows] = await db.query(
        `SELECT i.imageId, i.isPrimary, i.origin, i.uploadedAt, i.archivedAt, i.archiveReason, i.deletedAt,
                a.accountId AS ownerId, ${person('')} AS ownerName,
                ${person('ab_')} AS archivedByName
         FROM plant_images i
         JOIN accounts a ON a.accountId = i.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         LEFT JOIN accounts ab_a ON ab_a.accountId = i.archivedBy
         LEFT JOIN profiles ab_pr ON ab_pr.accountId = ab_a.accountId
         WHERE i.plantId = ? AND i.status = 'approved' ${all ? '' : 'AND i.archivedAt IS NOT NULL'}
         ORDER BY (i.deletedAt IS NOT NULL) DESC, (i.archivedAt IS NOT NULL) DESC, i.uploadedAt ASC, i.imageId ASC`,
        [plantId]
    );
    const [descRows] = await db.query(
        `SELECT d.descriptionId, d.isPrimary, d.uses, d.benefits, d.harmful, d.createdAt,
                d.archivedAt, d.archiveReason, d.deletedAt,
                a.accountId AS ownerId, ${person('')} AS ownerName,
                ${person('ab_')} AS archivedByName
         FROM plant_description d
         JOIN accounts a ON a.accountId = d.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         LEFT JOIN accounts ab_a ON ab_a.accountId = d.archivedBy
         LEFT JOIN profiles ab_pr ON ab_pr.accountId = ab_a.accountId
         WHERE d.plantId = ? AND d.status = 'approved' ${all ? '' : 'AND d.archivedAt IS NOT NULL'}
         ORDER BY (d.deletedAt IS NOT NULL) DESC, (d.archivedAt IS NOT NULL) DESC, d.isPrimary DESC, d.createdAt ASC`,
        [plantId]
    );

    const shape = (row, base) => {
        const own = stateOf(row);
        return {
            ...base,
            owner: { accountId: row.ownerId, name: row.ownerName },
            state: own,
            effective: effectiveStatus(row, p, retentionDays, now),
            ...describeStatus(row, retentionDays, now),
            archiveReason: row.archiveReason || null,
            archivedByName: row.archivedByName || null,
            // The page offers what the server will accept: delete needs the piece or its plant archived.
            actions: {
                restore: own === 'archived',
                delete: own === 'archived' || (own === 'active' && plantState !== 'active'),
                undoDelete: own === 'deleted'
            }
        };
    };

    return {
        plant: {
            id: p.plantId,
            name: p.commonName,
            ...describeStatus(p, retentionDays, now),
            archiveReason: p.archiveReason || null
        },
        scope: all ? 'all' : 'archived',
        retentionDays,
        photos: photoRows.map((r) => shape(r, {
            id: r.imageId,
            kind: 'photo',
            isPrimary: Boolean(r.isPrimary),
            scanContribution: r.origin !== 'record',
            uploadedAt: r.uploadedAt,
            previewUrl: `/admin/api/plant-images/${encodeURIComponent(r.imageId)}`
        })),
        descriptions: descRows.map((r) => shape(r, {
            id: r.descriptionId,
            kind: 'description',
            isPrimary: Boolean(r.isPrimary),
            excerpt: excerpt(r),
            createdAt: r.createdAt
        }))
    };
}

// ---------------------------------------------------------------------------
// The user who uploaded it: GET /api/archive/mine
// ---------------------------------------------------------------------------

/**
 * Everything of the caller's own that is not public any more: their photos and descriptions that are
 * archived or deleted (or sit in an archived / deleted plant), and the plants they recorded that are.
 * Each item: { kind, id, plantId, plantName, state, via, archivedAt, deletedAt, purgeAt, daysLeft, ... }
 * `via` says what put it there: 'self' (that item) or 'plant' (its plant). No admin note is included.
 */
async function listMyArchive(accountId, options = {}, deps = {}) {
    const db = deps.db || mysqlPool;
    const retentionDays = await archiveRetention.getRetentionDays(db);
    const now = new Date();
    const plantCols = 'p.commonName AS plantName, p.archivedAt AS plantArchivedAt, p.deletedAt AS plantDeletedAt';

    const [photoRows] = await db.query(
        `SELECT i.imageId, i.plantId, i.origin, i.archivedAt, i.deletedAt, ${plantCols}
         FROM plant_images i JOIN plants p ON p.plantId = i.plantId
         WHERE i.accountId = ? AND i.status = 'approved'
           AND (i.archivedAt IS NOT NULL OR p.archivedAt IS NOT NULL)
         ORDER BY COALESCE(i.deletedAt, i.archivedAt, p.deletedAt, p.archivedAt) DESC
         LIMIT ?`,
        [accountId, MINE_LIMIT]
    );
    const [descRows] = await db.query(
        `SELECT d.descriptionId, d.plantId, d.archivedAt, d.deletedAt, ${plantCols}
         FROM plant_description d JOIN plants p ON p.plantId = d.plantId
         WHERE d.accountId = ? AND d.status = 'approved'
           AND (d.archivedAt IS NOT NULL OR p.archivedAt IS NOT NULL)
         ORDER BY COALESCE(d.deletedAt, d.archivedAt, p.deletedAt, p.archivedAt) DESC
         LIMIT ?`,
        [accountId, MINE_LIMIT]
    );
    const [plantRows] = await db.query(
        `SELECT p.plantId, p.commonName, p.archivedAt, p.deletedAt
         FROM plants p JOIN plant_contributors pc ON pc.plantId = p.plantId
         WHERE pc.accountId = ? AND pc.role = 'contributor' AND p.archivedAt IS NOT NULL
         ORDER BY COALESCE(p.deletedAt, p.archivedAt) DESC
         LIMIT ?`,
        [accountId, MINE_LIMIT]
    );

    const withPlant = (row) => ({ archivedAt: row.plantArchivedAt, deletedAt: row.plantDeletedAt });
    const items = [
        ...plantRows.map((r) => ({
            kind: 'plant', id: r.plantId, plantId: r.plantId, plantName: r.commonName,
            ...describeStatus(r, retentionDays, now), via: 'self'
        })),
        ...photoRows.map((r) => {
            const s = effectiveStatus(r, withPlant(r), retentionDays, now);
            return {
                kind: 'photo', id: r.imageId, plantId: r.plantId, plantName: r.plantName,
                scanContribution: r.origin !== 'record', ...s
            };
        }),
        ...descRows.map((r) => {
            const s = effectiveStatus(r, withPlant(r), retentionDays, now);
            return { kind: 'description', id: r.descriptionId, plantId: r.plantId, plantName: r.plantName, ...s };
        })
    ];

    const kind = ['plant', 'photo', 'description'].includes(options.kind) ? options.kind : null;
    const state = ['archived', 'deleted'].includes(options.state) ? options.state : null;
    const shown = items.filter((x) => (!kind || x.kind === kind) && (!state || x.state === state));
    // Waiting for deletion first (they have a date on them), then the newest archive.
    shown.sort((a, b) => (a.state === b.state ? 0 : a.state === 'deleted' ? -1 : 1));

    return {
        retentionDays,
        items: shown,
        counts: {
            archived: items.filter((x) => x.state === 'archived').length,
            deleted: items.filter((x) => x.state === 'deleted').length
        }
    };
}

/**
 * The status of ONE item of the caller's own, or null when it is not theirs or does not exist (the
 * route answers 404 for both, so it never confirms that someone else's item exists).
 * kind: 'plant' | 'photo' | 'description'. A plant counts as theirs when they recorded it.
 */
async function getMyStatus(accountId, kind, id, deps = {}) {
    if (!SAFE_ID.test(String(id || ''))) return null;
    const db = deps.db || mysqlPool;
    const retentionDays = await archiveRetention.getRetentionDays(db);
    const now = new Date();
    const plantCols = 'p.commonName AS plantName, p.archivedAt AS plantArchivedAt, p.deletedAt AS plantDeletedAt';

    if (kind === 'plant') {
        const [rows] = await db.query(
            `SELECT p.plantId, p.commonName, p.archivedAt, p.deletedAt
             FROM plants p JOIN plant_contributors pc ON pc.plantId = p.plantId
             WHERE p.plantId = ? AND pc.accountId = ? AND pc.role = 'contributor' LIMIT 1`,
            [id, accountId]
        );
        if (rows.length === 0) return null;
        return { kind, id, plantId: rows[0].plantId, plantName: rows[0].commonName, retentionDays, ...describeStatus(rows[0], retentionDays, now), via: 'self' };
    }
    if (kind === 'photo') {
        const [rows] = await db.query(
            `SELECT i.imageId, i.plantId, i.archivedAt, i.deletedAt, ${plantCols}
             FROM plant_images i JOIN plants p ON p.plantId = i.plantId
             WHERE i.imageId = ? AND i.accountId = ? AND i.status = 'approved' LIMIT 1`,
            [id, accountId]
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
            kind, id, plantId: r.plantId, plantName: r.plantName, retentionDays,
            ...effectiveStatus(r, { archivedAt: r.plantArchivedAt, deletedAt: r.plantDeletedAt }, retentionDays, now)
        };
    }
    if (kind === 'description') {
        const [rows] = await db.query(
            `SELECT d.descriptionId, d.plantId, d.archivedAt, d.deletedAt, ${plantCols}
             FROM plant_description d JOIN plants p ON p.plantId = d.plantId
             WHERE d.descriptionId = ? AND d.accountId = ? AND d.status = 'approved' LIMIT 1`,
            [id, accountId]
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
            kind, id, plantId: r.plantId, plantName: r.plantName, retentionDays,
            ...effectiveStatus(r, { archivedAt: r.plantArchivedAt, deletedAt: r.plantDeletedAt }, retentionDays, now)
        };
    }
    return null;
}

module.exports = {
    STATUS_FILTERS, getArchiveSummary, listArchivePlants, getArchivePieces, listMyArchive, getMyStatus
};
