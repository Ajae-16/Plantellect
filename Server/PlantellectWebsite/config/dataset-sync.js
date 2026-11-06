// config/dataset-sync.js
//
// Keeps several admins' views of the dataset in step. Three small parts that work together:
//
//   COUNTERS     dataset_sync: one number per area ("scope"), bumped whenever something in that area changes. A page that
//                remembers the numbers it loaded with can tell, from one tiny read, that it is out of date. 'all' is also
//                the change log's cursor, and 'locks' moves whenever a "Ben is working on this" marker appears or goes.
//   CHANGE LOG   dataset_changes: one row per change saying WHO did WHAT to WHICH items. It is what the banner reads out
//                ("Ben moved 3 photos"), and it already carries the ids, so a later step can patch one row or photo of
//                the page instead of reloading it.
//   LOCKS        dataset_locks: short leases on items (a photo, a plant, a review set ...). Two kinds:
//                  op     held for the length of ONE request by the server, so two admins cannot change the same item at
//                         the same moment. Taken and released inside the route; a crash leaves at most a minute of lease.
//                  claim  "I am working on this": a page marks what the admin has selected or opened and renews it every
//                         few seconds. Other admins see who, and their own changes to those items are refused (409) until
//                         the claim is released or lapses.
//                A SPECIES LOCK is a claim on a whole species folder (key lbl:<name>), taken on purpose with a button. It
//                covers the species in train, val and test at once, and also Other plant photos filed under the same name.
//                It lasts longer than a selection claim (speciesLockSeconds) and survives a page reload.
//
// What this is NOT: the counters inform, the locks prevent. Neither replaces the row locks (SELECT ... FOR UPDATE) that the
// photo queries already take inside their transactions; those keep one request's reads and writes consistent, these keep
// two PEOPLE from working on the same thing at once.
//
// Safe before the migration: recording a change and taking an operation lock never fail a request. If the tables are
// missing (npm run db:migrate not run yet) they log one warning and the dataset page keeps working without any of this.
//
// The database is injected (`deps`) so the rules can be tested without MySQL. Callers pass nothing.

const crypto = require('crypto');
const settings = require('./settings');

// The areas. A change names one or more; a page watches the ones it shows.
//   folder     the hand-made training folder (ML service): clusters, removals, moves, groups, parts
//   training   photo rows: training status, part, group, which plant a contribution belongs to, archive
//   species    the promotion table
//   snapshots  database snapshots
//   audit      the audit's settings and the model that compares photos
const SCOPES = ['folder', 'training', 'species', 'snapshots', 'audit'];
// 'all' counts every logged change (its value IS the newest change id). 'locks' counts claim markers coming and going.
const COUNTERS = ['all', 'locks', ...SCOPES];

// What a lock key may look like. Keys are built here and by the routes, never taken from a request as they are.
const KEY = /^(?:(?:photo|pid|plant|cluster|species|quarantine|lbl):[A-Za-z0-9_-]{1,40}|snapshot)$/;
const ID_PART = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_KEYS = 1000;

const keys = {
    photo: (id) => `photo:${id}`,
    pid: (id) => `pid:${id}`,
    plant: (id) => `plant:${id}`,
    cluster: (id) => `cluster:${id}`,
    species: (id) => `species:${id}`,
    quarantine: (id) => `quarantine:${id}`,
    /**
     * A species folder, by its name: lbl:<readable part>-<10 hex of a hash of the whole lower-cased name>. The hash keeps two
     * names whose readable parts are alike apart ("Ficus sp. A" / "Ficus sp-A"); the name is compared without case or extra
     * spaces, as the move panel compares it, so "aloe  vera" and "Aloe vera" are one lock.
     */
    label: (name) => {
        const clean = String(name == null ? '' : name).trim().replace(/\s+/g, ' ').toLowerCase();
        const readable = clean.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 26) || 'x';
        return `lbl:${readable}-${crypto.createHash('sha1').update(clean).digest('hex').slice(0, 10)}`;
    },
    snapshot: 'snapshot'
};

/** The kinds of folder a species lock covers. Non plant folders are not species. */
const LOCKABLE_KINDS = ['species', 'other_plant'];

/**
 * Lock keys for species names. Blank names are skipped. Returns { keys, byKey }: byKey maps each key back to the name, so a
 * refusal can say "Ben has locked Aloe vera" (the lock table stores the key, not the name).
 */
function labelKeys(names) {
    const byKey = new Map();
    for (const name of Array.isArray(names) ? names : []) {
        if (typeof name !== 'string' || !name.trim()) continue;
        const key = keys.label(name);
        if (!byKey.has(key)) byKey.set(key, name.trim().replace(/\s+/g, ' '));
    }
    return { keys: [...byKey.keys()], byKey };
}

const isSpeciesKey = (key) => typeof key === 'string' && key.startsWith('lbl:');

/** Lock keys for a list of ids, skipping anything that is not a plain id (the route's own validation answers for those). */
function keysFor(kind, ids) {
    if (!Array.isArray(ids)) return [];
    const out = [];
    for (const id of ids) {
        if (typeof id === 'string' && ID_PART.test(id) && keys[kind]) out.push(keys[kind](id));
        if (out.length >= MAX_KEYS) break;
    }
    return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// SQL. Kept in one place on purpose: the tests' fake database answers exactly these statements.
// ---------------------------------------------------------------------------

const marks = (n) => Array.from({ length: n }, () => '?').join(', ');

const SQL = {
    counters: 'SELECT scope, version FROM dataset_sync',
    // Same trick as config/ids.js: LAST_INSERT_ID(expr) sets and returns the new value in one statement. Because this
    // row is locked until the transaction ends, changes are numbered and committed in the same order, so a page that
    // has seen change N can never find a change below N appearing later.
    nextChange: "UPDATE dataset_sync SET version = LAST_INSERT_ID(version + 1) WHERE scope = 'all'",
    lastId: 'SELECT LAST_INSERT_ID() AS id',
    insertChange:
        'INSERT INTO dataset_changes (changeId, scopes, action, entityType, entityIds, entityCount, accountId, actorName, summary) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    bump: (n) => `UPDATE dataset_sync SET version = version + 1 WHERE scope IN (${marks(n)})`,
    tail:
        'SELECT changeId, scopes, action, entityType, entityIds, entityCount, accountId, actorName, summary, ' +
        'TIMESTAMPDIFF(SECOND, createdAt, NOW()) AS ageSeconds FROM dataset_changes ORDER BY changeId DESC LIMIT ?',
    pruneChanges: 'DELETE FROM dataset_changes WHERE createdAt < DATE_SUB(NOW(), INTERVAL ? DAY)',
    actor: 'SELECT username FROM accounts WHERE accountId = ?',

    expireIn: (n) => `DELETE FROM dataset_locks WHERE expiresAt <= NOW() AND lockKey IN (${marks(n)})`,
    lockInsert: (n) =>
        'INSERT IGNORE INTO dataset_locks (lockKey, accountId, ownerName, purpose, kind, token, expiresAt) VALUES ' +
        Array.from({ length: n }, () => '(?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))').join(', '),
    lockHolders: (n) => `SELECT lockKey, accountId, ownerName, purpose, token FROM dataset_locks WHERE lockKey IN (${marks(n)})`,
    lockRenew: (n) =>
        'UPDATE dataset_locks SET expiresAt = GREATEST(expiresAt, DATE_ADD(NOW(), INTERVAL ? SECOND)) ' +
        `WHERE accountId = ? AND token <> ? AND lockKey IN (${marks(n)})`,
    releaseToken: 'DELETE FROM dataset_locks WHERE token = ? AND accountId = ?',
    releaseKeys: (n) => `DELETE FROM dataset_locks WHERE accountId = ? AND kind = 'claim' AND lockKey IN (${marks(n)})`,
    // A page closing lets go of its selection claims, but NOT of species locks: a reload also fires "page closed", and a
    // species lock must survive it (the next page picks it up again; a really closed tab stops renewing and it lapses).
    releaseAll: "DELETE FROM dataset_locks WHERE accountId = ? AND kind = 'claim' AND lockKey NOT LIKE 'lbl:%'",
    renewOwn: (n) =>
        "UPDATE dataset_locks SET expiresAt = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE accountId = ? AND kind = 'claim' AND lockKey LIKE 'lbl:%' " +
        `AND lockKey IN (${marks(n)})`,
    claims: "SELECT lockKey, accountId, ownerName, purpose FROM dataset_locks WHERE kind = 'claim' AND expiresAt > NOW() ORDER BY accountId, lockKey",
    sweepLocks: 'DELETE FROM dataset_locks WHERE expiresAt <= NOW()'
};

// ---------------------------------------------------------------------------
// Schema. ONE definition, read by config/seed.cjs (a new database) and config/migrate.cjs (an existing one), so the two
// can never drift apart. None of these tables has a prefixed key: dataset_sync and dataset_locks have natural primary
// keys, and dataset_changes takes its id from the 'all' counter (see SQL.nextChange), so there is no id_counters row.
// ---------------------------------------------------------------------------

const SCHEMA = [
    ['dataset_sync', `
        CREATE TABLE dataset_sync (
            scope VARCHAR(24) NOT NULL PRIMARY KEY,
            version BIGINT UNSIGNED NOT NULL DEFAULT 0,
            updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
    ['dataset_changes', `
        CREATE TABLE dataset_changes (
            changeId BIGINT UNSIGNED NOT NULL PRIMARY KEY,
            scopes VARCHAR(120) NOT NULL,
            action VARCHAR(48) NOT NULL,
            entityType VARCHAR(16) NOT NULL,
            entityIds JSON DEFAULT NULL,
            entityCount INT NOT NULL DEFAULT 0,
            accountId VARCHAR(18) DEFAULT NULL,
            actorName VARCHAR(64) NOT NULL,
            summary VARCHAR(255) NOT NULL DEFAULT '',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_dataset_changes_created (createdAt),
            FOREIGN KEY (accountId) REFERENCES accounts(accountId) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
    ['dataset_locks', `
        CREATE TABLE dataset_locks (
            lockKey VARCHAR(64) NOT NULL PRIMARY KEY,
            accountId VARCHAR(18) NOT NULL,
            ownerName VARCHAR(64) NOT NULL,
            purpose VARCHAR(32) NOT NULL,
            kind ENUM('op','claim') NOT NULL DEFAULT 'op',
            token CHAR(32) NOT NULL,
            acquiredAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expiresAt DATETIME NOT NULL,
            INDEX idx_dataset_locks_expires (expiresAt),
            INDEX idx_dataset_locks_owner (accountId, kind),
            INDEX idx_dataset_locks_token (token),
            FOREIGN KEY (accountId) REFERENCES accounts(accountId) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`]
];

/** Creates whatever of the three tables is missing and the counter rows. Idempotent. Returns { created: [...], counters: n }. */
async function ensureSchema(conn) {
    const created = [];
    for (const [table, ddl] of SCHEMA) {
        const [rows] = await conn.query(
            'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
            [table]
        );
        if (rows[0].n > 0) continue;
        await conn.query(ddl);
        created.push(table);
    }
    let counters = 0;
    for (const name of COUNTERS) {
        const [result] = await conn.query('INSERT IGNORE INTO dataset_sync (scope, version) VALUES (?, 0)', [name]);
        counters += result.affectedRows || 0;
    }
    return { created, counters };
}

function resolveDeps(deps = {}) {
    return { db: deps.db || require('./pool-mysql').mysqlPool };
}

// ---------------------------------------------------------------------------
// Never-throwing wrapper, and the one warning about a missing migration
// ---------------------------------------------------------------------------

let warned = false;
function warnOnce(err, what) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') {
        if (warned) return;
        warned = true;
        console.warn(`Dataset sync: ${what} skipped, a table is missing. Run "npm run db:migrate" (twice) to create it.`);
        return;
    }
    console.warn(`Dataset sync: ${what} failed:`, err && err.message);
}
/** Test hook: lets a test see the missing-table warning again. */
function resetWarning() { warned = false; }

// ---------------------------------------------------------------------------
// Counters + change log
// ---------------------------------------------------------------------------

const asScopes = (list) => [...new Set((Array.isArray(list) ? list : [list]).filter((s) => SCOPES.includes(s)))];

/** The current counters as { all, locks, folder, ... }. A counter with no row yet reads as 0. */
async function readCounters(deps) {
    const { db } = resolveDeps(deps);
    const [rows] = await db.query(SQL.counters);
    const out = {};
    for (const name of COUNTERS) out[name] = 0;
    for (const r of rows) if (name_ok(r.scope)) out[r.scope] = Number(r.version) || 0;
    return out;
}
const name_ok = (scope) => COUNTERS.includes(scope);

/** Moves the named counters up by one. Used on its own for locks; record() bumps its scopes itself. */
async function bump(scopes, deps) {
    const names = [...new Set(scopes)].filter(name_ok);
    if (names.length === 0) return;
    const { db } = resolveDeps(deps);
    await db.query(SQL.bump(names.length), names);
}

/**
 * Writes one change-log row and moves 'all' and the changed areas' counters, in one transaction.
 *   change: { scopes: ['training', ...], action, entityType, entityIds?, count?, summary, accountId, actorName }
 * Returns { changeId }. Throws on a database error; callers that must not fail use track().
 */
async function record(change, deps) {
    const scopes = asScopes(change && change.scopes);
    if (scopes.length === 0) throw new Error('A change needs at least one known scope');
    const { db } = resolveDeps(deps);
    const ids = Array.isArray(change.entityIds) ? change.entityIds.filter((v) => typeof v === 'string') : [];
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [moved] = await conn.query(SQL.nextChange);
        if (!moved || moved.affectedRows === 0) throw new Error('dataset_sync has no "all" row. Was the migration run?');
        const [idRows] = await conn.query(SQL.lastId);
        const changeId = Number(idRows[0].id);
        await conn.query(SQL.insertChange, [
            changeId,
            `,${scopes.join(',')},`,
            String(change.action || 'changed').slice(0, 48),
            String(change.entityType || 'item').slice(0, 16),
            ids.length ? JSON.stringify(ids.slice(0, 200)) : null,
            Number.isFinite(change.count) ? change.count : ids.length,
            change.accountId || null,
            String(change.actorName || 'An admin').slice(0, 64),
            String(change.summary || '').slice(0, 255)
        ]);
        await conn.query(SQL.bump(scopes.length), scopes);
        await conn.commit();
        return { changeId };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

/** The name an admin is known by in the log. Never throws. */
async function actorName(accountId, deps) {
    try {
        const { db } = resolveDeps(deps);
        const [rows] = await db.query(SQL.actor, [accountId]);
        return rows[0] && rows[0].username ? String(rows[0].username).slice(0, 64) : 'An admin';
    } catch (err) {
        return 'An admin';
    }
}

/**
 * record() for routes: looks the admin's name up, and swallows every failure (one warning). A change that was made is
 * never reported as failed because the log could not be written. Returns the change id, or null.
 */
async function track(change, deps) {
    try {
        const name = change.actorName || await actorName(change.accountId, deps);
        const out = await record({ ...change, actorName: name }, deps);
        return out.changeId;
    } catch (err) {
        warnOnce(err, 'recording a change');
        return null;
    }
}

const parseList = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value) return [];
    try { const v = JSON.parse(value); return Array.isArray(v) ? v : []; } catch (e) { return []; }
};

/** The newest `limit` log rows, newest first, in the shape the page reads. */
async function readTail(limit, deps) {
    const { db } = resolveDeps(deps);
    const [rows] = await db.query(SQL.tail, [limit || settings.dataset.sync.tail]);
    return rows.map((r) => ({
        id: Number(r.changeId),
        scopes: String(r.scopes || '').split(',').filter(Boolean),
        action: r.action,
        entityType: r.entityType,
        entityIds: parseList(r.entityIds),
        count: Number(r.entityCount) || 0,
        by: { accountId: r.accountId || null, name: r.actorName || 'An admin' },
        summary: r.summary || '',
        // How long ago, worked out by the database, so no clock or time zone of a browser or this server is involved.
        ageSeconds: Math.max(0, Number(r.ageSeconds) || 0)
    }));
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

const NOUN = { photo: 'photo', pid: 'photo', plant: 'plant', cluster: 'review set', species: 'species', quarantine: 'removed photo', snapshot: 'snapshot' };
const PLURAL = { photo: 'photos', plant: 'plants', 'review set': 'review sets', species: 'species', 'removed photo': 'removed photos', snapshot: 'snapshots' };
const nounOf = (key) => NOUN[String(key).split(':')[0]] || 'item';

/** "Ben is working on 3 of these photos right now." A species lock reads differently: it lasts, so waiting is not the advice. */
function describeConflicts(conflicts) {
    const inSpecies = conflicts.filter((c) => isSpeciesKey(c.key));
    if (inSpecies.length > 0) {
        // A lock the admin took on purpose (purpose 'species') lasts, so the advice is another species. Anything else on a species
        // key is another admin's move or removal in progress, which is over in a moment.
        const lasting = inSpecies.filter((c) => c.purpose === 'species');
        const named = lasting.length > 0 ? lasting : inSpecies;
        const owners = [...new Set(named.map((c) => c.name || 'Another admin'))];
        const who = owners.length === 1 ? owners[0] : owners.length === 2 ? `${owners[0]} and ${owners[1]}` : `${owners[0]} and ${owners.length - 1} others`;
        const labels = [...new Set(named.map((c) => c.label).filter(Boolean))];
        const what = labels.length === 0 ? (named.length === 1 ? 'this species' : `${named.length} of these species`)
            : labels.length <= 2 ? labels.map((l) => `"${l}"`).join(' and ') : `"${labels[0]}" and ${labels.length - 1} other species`;
        if (lasting.length > 0) return `${who} ${owners.length === 1 ? 'has' : 'have'} locked ${what}. Work on another species, or ask them to unlock it.`;
        return `${who} ${owners.length === 1 ? 'is' : 'are'} changing photos in ${what} right now. Wait a moment and try again.`;
    }
    const names = [...new Set(conflicts.map((c) => c.name || 'Another admin'))];
    const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`;
    const nouns = [...new Set(conflicts.map((c) => nounOf(c.key)))];
    const n = conflicts.length;
    let what;
    if (nouns.length !== 1) what = `${n} of these items`;
    else if (n === 1) what = `this ${nouns[0]}`;
    else what = `${n} of these ${PLURAL[nouns[0]] || nouns[0] + 's'}`;
    return `${who} ${names.length === 1 ? 'is' : 'are'} working on ${what} right now. Wait a moment, or reload to see what changed.`;
}

/** Thrown when another admin holds a lock on something this request needs. Routes answer it as 409 { code: 'locked' }. */
class LockedError extends Error {
    constructor(conflicts) {
        super(describeConflicts(conflicts));
        this.name = 'LockedError';
        this.status = 409;
        this.code = 'locked';
        this.expose = true;
        this.lockedBy = conflicts;
    }

    /** Names the species behind species-lock keys (byKey from labelKeys) and rewrites the message to match. Returns this. */
    withLabels(byKey) {
        for (const c of this.lockedBy) if (byKey && byKey.has(c.key)) c.label = byKey.get(c.key);
        this.message = describeConflicts(this.lockedBy);
        return this;
    }
}

const newToken = () => crypto.randomBytes(16).toString('hex');

/**
 * Takes leases on `lockKeys` for one admin.
 *   owner: { accountId, name, purpose, kind: 'op' | 'claim', seconds, partial }
 * All or none by default: if another admin holds any of them, whatever this call newly took is given back and a
 * LockedError names who. With owner.partial (claims) the free ones are kept and the busy ones are returned in `conflicts`.
 * A lock this admin already holds is only renewed (never shortened), so taking an operation lock on something you have
 * claimed is fine and leaves your claim alone. Returns { token, fresh, held, conflicts }.
 *
 * Each statement is atomic on its own, and the table's primary key decides a race: of two admins inserting the same key
 * at the same moment exactly one insert lands, and the other sees the winner when it reads the holders back.
 */
async function acquire(lockKeys, owner, deps) {
    const list = [...new Set(lockKeys)];
    if (list.length === 0) return { token: null, fresh: [], held: [], conflicts: [] };
    if (list.length > MAX_KEYS || !list.every((k) => KEY.test(k))) throw new TypeError('Bad lock key');
    const { db } = resolveDeps(deps);
    const seconds = owner.seconds || settings.dataset.sync.opLockSeconds;
    const token = newToken();
    const name = String(owner.name || 'An admin').slice(0, 64);
    const purpose = String(owner.purpose || 'editing').slice(0, 32);
    const kind = owner.kind === 'claim' ? 'claim' : 'op';

    let holders = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        await db.query(SQL.expireIn(list.length), list);
        const values = [];
        for (const k of list) values.push(k, owner.accountId, name, purpose, kind, token, seconds);
        await db.query(SQL.lockInsert(list.length), values);
        const [rows] = await db.query(SQL.lockHolders(list.length), list);
        holders = rows;
        // A lock that lapsed between the insert and the read leaves no row at all: go round once more to take it.
        if (list.every((k) => holders.some((h) => h.lockKey === k))) break;
    }

    const byKey = new Map(holders.map((h) => [h.lockKey, h]));
    const conflicts = [];
    const held = [];
    const fresh = [];
    for (const k of list) {
        const h = byKey.get(k);
        if (h && h.accountId === owner.accountId) {
            held.push(k);
            if (h.token === token) fresh.push(k);
        } else if (h) {
            conflicts.push({ key: k, accountId: h.accountId, name: h.ownerName, purpose: h.purpose });
        }
    }

    if (conflicts.length > 0 && !owner.partial) {
        await db.query(SQL.releaseToken, [token, owner.accountId]);
        throw new LockedError(conflicts);
    }
    const renewed = held.filter((k) => !fresh.includes(k));
    if (renewed.length > 0) await db.query(SQL.lockRenew(renewed.length), [seconds, owner.accountId, token, ...renewed]);
    if (kind === 'claim' && fresh.length > 0) await bump(['locks'], deps);
    return { token, fresh, held, conflicts };
}

/**
 * acquire() for operations: a database problem (the table is missing, the connection dropped) is logged and the operation
 * goes ahead without a lock, because the row locks inside the photo queries still protect the data. Only a real
 * conflict, a LockedError, stops it.
 */
async function acquireForOperation(lockKeys, owner, deps) {
    try {
        return await acquire(lockKeys, { ...owner, kind: 'op' }, deps);
    } catch (err) {
        if (err instanceof LockedError) throw err;
        warnOnce(err, 'taking a lock');
        return { token: null, fresh: [], held: [], conflicts: [], degraded: true };
    }
}

/** Gives back what an operation newly took. Never throws. */
async function releaseToken(token, accountId, deps) {
    if (!token) return;
    try {
        const { db } = resolveDeps(deps);
        await db.query(SQL.releaseToken, [token, accountId]);
    } catch (err) {
        warnOnce(err, 'releasing a lock');
    }
}

/** Runs fn while this admin holds operation locks on lockKeys. owner: { accountId, name, purpose, seconds? }. */
async function withLocks(lockKeys, owner, fn, deps) {
    const lock = await acquireForOperation(lockKeys, owner, deps);
    try {
        return await fn();
    } finally {
        await releaseToken(lock.token, owner.accountId, deps);
    }
}

/** Lets go of this admin's claims on the given keys (or all of them). Returns how many went. */
async function releaseClaims(accountId, lockKeys, deps) {
    const { db } = resolveDeps(deps);
    let result;
    if (lockKeys === 'all') {
        [result] = await db.query(SQL.releaseAll, [accountId]);
    } else {
        const list = [...new Set(lockKeys)].filter((k) => KEY.test(k)).slice(0, MAX_KEYS);
        if (list.length === 0) return 0;
        [result] = await db.query(SQL.releaseKeys(list.length), [accountId, ...list]);
    }
    const released = (result && result.affectedRows) || 0;
    if (released > 0) await bump(['locks'], deps);
    return released;
}

/**
 * Extends this admin's species locks on the given keys by `seconds` from now (the open page calls it every third of the
 * lease). Only locks the admin already holds are touched, and a lock that lapsed and was taken by someone else stays theirs.
 * Returns the keys this admin still holds afterwards; the rest were lost and the page must say so.
 */
async function renewSpeciesLocks(accountId, lockKeys, seconds, deps) {
    const list = [...new Set(lockKeys)].filter((k) => isSpeciesKey(k) && KEY.test(k)).slice(0, 50);
    if (list.length === 0) return [];
    const { db } = resolveDeps(deps);
    await db.query(SQL.renewOwn(list.length), [seconds || settings.dataset.sync.speciesLockSeconds, accountId, ...list]);
    // Read back instead of counting changed rows: a renewal inside the same second changes nothing and must still count.
    const [rows] = await db.query(SQL.lockHolders(list.length), list);
    const mine = new Set(rows.filter((r) => r.accountId === accountId).map((r) => r.lockKey));
    return list.filter((k) => mine.has(k));
}

/** Everyone's live claims, grouped by admin: [{ accountId, name, purpose, keys: [...] }]. */
async function readClaims(deps) {
    const { db } = resolveDeps(deps);
    const [rows] = await db.query(SQL.claims);
    const byOwner = new Map();
    for (const r of rows) {
        if (!byOwner.has(r.accountId)) byOwner.set(r.accountId, { accountId: r.accountId, name: r.ownerName, purpose: r.purpose, keys: [] });
        byOwner.get(r.accountId).keys.push(r.lockKey);
    }
    return [...byOwner.values()];
}

// ---------------------------------------------------------------------------
// The answer to "did anything change?"
// ---------------------------------------------------------------------------

/**
 * The page's change token. It is built from the counters alone, so deciding "nothing changed" costs one tiny read and no
 * list queries. The poll interval is part of it, so a changed setting reaches open pages with the next answer.
 */
function etagOf(counters, pollSeconds = settings.dataset.sync.pollSeconds) {
    return `W/"${COUNTERS.map((k) => counters[k] || 0).join('.')}-${pollSeconds}"`;
}

/** Does an If-None-Match header name this etag? (weak comparison, as for a GET) */
function etagMatches(header, etag) {
    if (typeof header !== 'string' || !header.trim()) return false;
    if (header.trim() === '*') return true;
    const bare = (v) => v.trim().replace(/^W\//, '');
    const wanted = bare(etag);
    return header.split(',').some((part) => bare(part) === wanted);
}

/**
 * The full answer, for when the counters moved. `counters` are the ones the etag was made from.
 * { ok, serverNow, pollSeconds, claimSeconds, me, counters, changes (newest first), locks }
 */
async function readSync(accountId, counters, deps) {
    const [changes, locks] = await Promise.all([readTail(undefined, deps), readClaims(deps)]);
    return {
        ok: true,
        serverNow: new Date().toISOString(),
        pollSeconds: settings.dataset.sync.pollSeconds,
        claimSeconds: settings.dataset.sync.claimLockSeconds,
        claimMaxKeys: settings.dataset.sync.claimMaxKeys,
        speciesLockSeconds: settings.dataset.sync.speciesLockSeconds,
        speciesIdleSeconds: settings.dataset.sync.speciesIdleMinutes * 60,
        speciesLockMax: settings.dataset.sync.speciesLockMax,
        me: { accountId },
        counters,
        changes,
        locks
    };
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Deletes lapsed locks and bumps the lock counter, so a marker whose owner closed the tab without a goodbye goes away. */
async function sweep(deps) {
    try {
        const { db } = resolveDeps(deps);
        const [result] = await db.query(SQL.sweepLocks);
        const n = (result && result.affectedRows) || 0;
        if (n > 0) await bump(['locks'], deps);
        return n;
    } catch (err) {
        warnOnce(err, 'sweeping locks');
        return 0;
    }
}

/** Deletes change-log rows older than the retention. */
async function prune(deps) {
    try {
        const { db } = resolveDeps(deps);
        const [result] = await db.query(SQL.pruneChanges, [settings.dataset.sync.retentionDays]);
        return (result && result.affectedRows) || 0;
    } catch (err) {
        warnOnce(err, 'pruning the change log');
        return 0;
    }
}

/** Starts the two timers. They never keep the process alive on their own. Call once, after the database is up. */
function startHousekeeping(deps) {
    const sweeper = setInterval(() => { sweep(deps); }, settings.dataset.sync.sweepSeconds * 1000);
    const pruner = setInterval(() => { prune(deps); }, 6 * 60 * 60 * 1000);
    if (sweeper.unref) sweeper.unref();
    if (pruner.unref) pruner.unref();
    prune(deps);
    return () => { clearInterval(sweeper); clearInterval(pruner); };
}

module.exports = {
    SCOPES, COUNTERS, KEY, SQL, SCHEMA, ensureSchema, keys, keysFor, labelKeys, isSpeciesKey, LOCKABLE_KINDS,
    LockedError, describeConflicts,
    readCounters, bump, record, track, actorName, readTail,
    acquire, acquireForOperation, withLocks, releaseToken, releaseClaims, renewSpeciesLocks, readClaims,
    etagOf, etagMatches, readSync,
    sweep, prune, startHousekeeping, resetWarning
};
