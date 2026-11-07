// Admin: archive and unarchive ONE contributor's description of a plant (the Archive button on a
// description in the plant edit dialog, and Restore on the Archive page).
//
// Archived = the description is out of the public plant page, the library card and the voting, and it
// cannot be edited or made primary. Nothing is deleted: the text, the measurements, the votes and the
// author are untouched, and Unarchive brings it back exactly as it was. This is NOT the "hidden by
// community votes" state (plant_description.hiddenAt): that one is set by votes and cleared by an admin on
// the plant reports queue, this one is the admin's own decision. The two are independent.
//
// A description that is the primary one hands the flag to the best remaining description (highest
// up - down votes, then oldest; archived and vote-hidden ones never qualify). With none left the flag STAYS
// on the archived description on purpose, the same rule description-vote-mysql.js uses for a hidden one:
// the plant must not drop out of the library because of one admin click. The answer says so
// (noReplacement) and the next approved description takes the flag.
//
// "Delete" is a further step on an archived description (config/archive-delete-mysql.js).

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ARCHIVE_REASON_MAX = 255;

const fail = (error, code = 400) => ({ error, code });

const defaultDb = () => require('./pool-mysql').mysqlPool;

function cleanReason(input) {
    if (input === undefined || input === null) return { reason: null };
    if (typeof input !== 'string') return fail('The archive reason must be text');
    const reason = input.split(/\s+/).filter(Boolean).join(' ');
    if (reason.length > ARCHIVE_REASON_MAX) {
        return fail(`The archive reason can be at most ${ARCHIVE_REASON_MAX} characters`);
    }
    return { reason: reason || null };
}

function checkIds(plantId, descriptionId) {
    if (!SAFE_ID.test(String(plantId || '')) || !SAFE_ID.test(String(descriptionId || ''))) {
        return fail('That is not a valid plant or description id');
    }
    return null;
}

async function inTransaction(db, fn) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        if (result && result.error) await conn.rollback();
        else await conn.commit();
        return result;
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Gives the primary flag to the best remaining visible description. Returns its id, or null when
 * none is left (the flag then stays where it is).
 */
async function handOverPrimary(conn, plantId, excludeId) {
    const [rows] = await conn.query(
        `SELECT d.descriptionId
         FROM plant_description d
         WHERE d.plantId = ? AND d.status = 'approved' AND d.hiddenAt IS NULL AND d.archivedAt IS NULL
           AND d.descriptionId <> ?
         ORDER BY (SELECT COUNT(*) FROM description_votes v WHERE v.descriptionId = d.descriptionId AND v.voteValue = 'up')
                - (SELECT COUNT(*) FROM description_votes v WHERE v.descriptionId = d.descriptionId AND v.voteValue = 'down') DESC,
                  d.createdAt ASC
         LIMIT 1`,
        [plantId, excludeId]
    );
    if (rows.length === 0) return null;
    await conn.query('UPDATE plant_description SET isPrimary = FALSE WHERE plantId = ?', [plantId]);
    await conn.query('UPDATE plant_description SET isPrimary = TRUE WHERE descriptionId = ?', [rows[0].descriptionId]);
    return rows[0].descriptionId;
}

/**
 * Archives one approved description. options: { reason?, accountId? } (accountId is the admin and goes
 * into archivedBy, a foreign key, so it must be a real account or null).
 * Returns { ok: true, plantId, descriptionId, wasPrimary, newPrimaryId, noReplacement, archiveReason } or { error, code }.
 */
async function archiveDescription(plantId, descriptionId, options = {}, deps = {}) {
    const bad = checkIds(plantId, descriptionId);
    if (bad) return bad;
    const checked = cleanReason(options && options.reason);
    if (checked.error) return checked;
    const accountId = (options && options.accountId) || null;
    const db = deps.db || defaultDb();

    return inTransaction(db, async (conn) => {
        const [rows] = await conn.query(
            `SELECT descriptionId, status, isPrimary, archivedAt, deletedAt
             FROM plant_description WHERE descriptionId = ? AND plantId = ? FOR UPDATE`,
            [descriptionId, plantId]
        );
        if (rows.length === 0) return fail('Description not found on this plant', 404);
        const d = rows[0];
        if (d.status !== 'approved') return fail('Only an approved description can be archived', 409);
        if (d.archivedAt) return fail('This description is already archived', 409);

        await conn.query(
            'UPDATE plant_description SET archivedAt = NOW(), archivedBy = ?, archiveReason = ? WHERE descriptionId = ?',
            [accountId, checked.reason, descriptionId]
        );
        const wasPrimary = Boolean(d.isPrimary);
        let newPrimaryId = null;
        if (wasPrimary) newPrimaryId = await handOverPrimary(conn, plantId, descriptionId);
        return {
            ok: true, plantId, descriptionId, wasPrimary, newPrimaryId,
            noReplacement: wasPrimary && !newPrimaryId,
            archiveReason: checked.reason
        };
    });
}

/**
 * Brings an archived description back. It returns as an ordinary (non-primary) description unless it
 * still carries the primary flag, which it only does when it was the plant's only visible one.
 * A description in the Deleted status must be un-deleted first. Returns { ok: true, plantId, descriptionId } or { error, code }.
 */
async function unarchiveDescription(plantId, descriptionId, deps = {}) {
    const bad = checkIds(plantId, descriptionId);
    if (bad) return bad;
    const db = deps.db || defaultDb();
    return inTransaction(db, async (conn) => {
        const [rows] = await conn.query(
            `SELECT descriptionId, status, archivedAt, deletedAt
             FROM plant_description WHERE descriptionId = ? AND plantId = ? FOR UPDATE`,
            [descriptionId, plantId]
        );
        if (rows.length === 0) return fail('Description not found on this plant', 404);
        const d = rows[0];
        if (d.status !== 'approved') return fail('Only an approved description can be unarchived', 409);
        if (!d.archivedAt) return fail('This description is not archived', 409);
        if (d.deletedAt) return fail('This description is waiting to be deleted. Undo the deletion first.', 409);
        await conn.query(
            'UPDATE plant_description SET archivedAt = NULL, archivedBy = NULL, archiveReason = NULL WHERE descriptionId = ?',
            [descriptionId]
        );
        return { ok: true, plantId, descriptionId };
    });
}

module.exports = { archiveDescription, unarchiveDescription, handOverPrimary, cleanReason, ARCHIVE_REASON_MAX };
