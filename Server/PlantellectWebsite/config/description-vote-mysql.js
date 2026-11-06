// Community votes on plant descriptions (thumbs up / thumbs down on the plant profile).
//
// The same loop as the discovery "not a plant" quorum, applied to a description:
//   - one ballot per account per description (composite primary key), insert / switch /
//     retract against that key;
//   - enough DOWN votes hide the description at once and notify the admin;
//   - enough UP votes notify the admin that it is worth making the primary one;
//   - the admin decides: make primary, restore, dismiss, or take it out.
//
// Voter identities, per-reason counts and the voters' own notes are ADMIN-only. The
// public side only ever learns the up count, its own ballot, and that a description is gone.

const { mysqlPool } = require('./pool-mysql');
const settings = require('./settings');
const { parsePaging } = require('./shared-mysql');
const { getVoteSettings } = require('./description-vote-settings');

function fail(error, code, extra) {
    return { error, code, ...(extra || {}) };
}

const cfg = () => settings.descriptionVotes;

function reasonLabel(code) {
    const found = cfg().reasons.find((r) => r.code === code);
    return found ? found.label : code;
}

// ---------------------------------------------------------------------------
// Input validation (pure: unit-tested without a database)
// ---------------------------------------------------------------------------

/**
 * Validates the body of a vote. Returns { value, reasonCode, reasonNote } or { error }.
 *   up    -> no reason.
 *   down  -> reasonCode must be one of the premade codes. The voter's own words are
 *            accepted ONLY with 'other' (and are then required); a note sent with a
 *            premade reason is dropped, so the premade list stays countable.
 */
function normalizeVoteInput(body) {
    const b = body || {};
    const value = String(b.value || '').toLowerCase();
    if (value !== 'up' && value !== 'down') return { error: 'value must be "up" or "down"' };
    if (value === 'up') return { value, reasonCode: null, reasonNote: null };

    const reasonCode = String(b.reasonCode || '');
    if (!cfg().reasons.some((r) => r.code === reasonCode)) {
        return { error: 'Choose a reason for the down vote' };
    }
    if (reasonCode !== 'other') return { value, reasonCode, reasonNote: null };

    // eslint-disable-next-line no-control-regex
    const note = String(b.reasonNote || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (note.length < 3) return { error: 'Write a short note explaining the problem' };
    if (note.length > cfg().noteMaxLength) {
        return { error: `The note can be at most ${cfg().noteMaxLength} characters` };
    }
    return { value, reasonCode, reasonNote: note };
}

// ---------------------------------------------------------------------------
// Primary-description housekeeping
// ---------------------------------------------------------------------------

/**
 * Promotes the best remaining visible description when the primary one is hidden or taken
 * out: highest (up - down), then oldest. Returns the new primary id, or null when none is
 * left (the caller decides whether the flag stays where it is).
 */
async function promoteReplacement(conn, plantId, excludeId) {
    const [rows] = await conn.query(
        `SELECT d.descriptionId
         FROM plant_description d
         WHERE d.plantId = ? AND d.status = 'approved' AND d.hiddenAt IS NULL AND d.descriptionId <> ?
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

// ---------------------------------------------------------------------------
// Casting a vote (signed-in user)
// ---------------------------------------------------------------------------

/**
 * Hides one description. A primary hands over to the best remaining one; with none left the
 * flag STAYS on the hidden description on purpose: the plant must not drop out of the library
 * because of votes alone. The admin is notified and decides.
 */
async function hideDescription(conn, plantId, descriptionId, wasPrimary) {
    await conn.query('UPDATE plant_description SET hiddenAt = NOW() WHERE descriptionId = ?', [descriptionId]);
    if (wasPrimary) await promoteReplacement(conn, plantId, descriptionId);
}

/**
 * Applies the CURRENT hide threshold to descriptions that already have enough down votes. Run
 * after an admin lowers the threshold: otherwise a description sitting at 3 down votes would
 * only be hidden when somebody happened to vote on it again. Returns how many were hidden.
 */
async function applyDownvoteThreshold() {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const { downvoteHide } = await getVoteSettings(conn);
        const [rows] = await conn.query(
            `SELECT d.descriptionId, d.plantId, d.isPrimary
             FROM plant_description d
             JOIN description_votes v ON v.descriptionId = d.descriptionId AND v.voteValue = 'down'
             WHERE d.status = 'approved' AND d.hiddenAt IS NULL
             GROUP BY d.descriptionId, d.plantId, d.isPrimary
             HAVING COUNT(*) >= ?
             ORDER BY d.plantId, d.descriptionId`,
            [downvoteHide]
        );
        for (const r of rows) await hideDescription(conn, r.plantId, r.descriptionId, Boolean(r.isPrimary));
        await conn.commit();
        return rows.length;
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Sets or removes the caller's ballot on one description.
 *
 *   cast     (default) idempotent: no ballot -> cast; same value again -> nothing changes
 *            (a double click or a retried request cannot move the tally); the other value
 *            -> SWITCH, which also refreshes votedAt so "votes since the admin last cleared
 *            this" stays true to the order things happened.
 *   retract  { retract: true } deletes the ballot and needs no reason.
 *
 * Retraction is its own call rather than "the same POST again" on purpose: a toggle makes a
 * retry look like a second vote, and a down vote needs a reason a retraction cannot supply.
 */
async function castDescriptionVote(plantId, descriptionId, accountId, body, { retract = false } = {}) {
    let input = null;
    if (!retract) {
        input = normalizeVoteInput(body);
        if (input.error) return fail(input.error, 400);
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT d.accountId, d.status, d.hiddenAt, d.isPrimary, p.archivedAt
             FROM plant_description d
             JOIN plants p ON p.plantId = d.plantId
             WHERE d.descriptionId = ? AND d.plantId = ? FOR UPDATE`,
            [descriptionId, plantId]
        );
        if (rows.length === 0 || rows[0].status !== 'approved' || rows[0].archivedAt) {
            await conn.rollback();
            return fail('Description not found', 404);
        }
        const desc = rows[0];
        if (desc.accountId === accountId) {
            await conn.rollback();
            return fail('You cannot vote on your own description', 403);
        }
        if (desc.hiddenAt) {
            await conn.rollback();
            return fail('This description is hidden while an administrator reviews it', 409);
        }

        let myVote = null;
        if (retract) {
            await conn.query(
                'DELETE FROM description_votes WHERE descriptionId = ? AND accountId = ?',
                [descriptionId, accountId]
            );
        } else {
            // votedAt is listed FIRST: MySQL evaluates these left to right, so the comparison
            // still sees the old voteValue.
            await conn.query(
                `INSERT INTO description_votes (descriptionId, accountId, voteValue, reasonCode, reasonNote)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     votedAt = IF(voteValue <> VALUES(voteValue), NOW(), votedAt),
                     voteValue = VALUES(voteValue),
                     reasonCode = VALUES(reasonCode),
                     reasonNote = VALUES(reasonNote)`,
                [descriptionId, accountId, input.value, input.reasonCode, input.reasonNote]
            );
            myVote = input.value;
        }

        const [[tally]] = await conn.query(
            `SELECT SUM(voteValue = 'up') AS up, SUM(voteValue = 'down') AS down
             FROM description_votes WHERE descriptionId = ?`,
            [descriptionId]
        );
        const up = Number(tally.up || 0);
        const down = Number(tally.down || 0);

        let hidden = false;
        const { downvoteHide } = await getVoteSettings(conn);
        if (down >= downvoteHide) {
            await hideDescription(conn, plantId, descriptionId, desc.isPrimary);
            hidden = true;
        }

        await conn.commit();
        return { descriptionId, up, myVote, retracted: retract, hidden };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Public read: what the plant page needs to draw the thumbs
// ---------------------------------------------------------------------------

/**
 * Everything the plant page needs to draw the thumbs AND the votes table, per visible
 * description: the up and down totals (from vw_description_votes), the premade reasons counted,
 * the voters' own notes WITHOUT names, and the viewer's own ballot. Voter identities stay
 * admin-only (listVoters).
 */
async function getVoteSummary(plantId, accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT d.descriptionId, d.accountId AS authorId, t.upVotes, t.downVotes
         FROM plant_description d
         JOIN vw_description_votes t ON t.descriptionId = d.descriptionId
         WHERE d.plantId = ? AND d.status = 'approved' AND d.hiddenAt IS NULL`,
        [plantId]
    );
    const ids = rows.map((r) => r.descriptionId);
    const mine = new Map();
    const reasons = new Map();
    const notes = new Map();

    if (ids.length) {
        if (accountId) {
            const [mineRows] = await mysqlPool.query(
                'SELECT descriptionId, voteValue FROM description_votes WHERE accountId = ? AND descriptionId IN (?)',
                [accountId, ids]
            );
            for (const m of mineRows) mine.set(m.descriptionId, m.voteValue);
        }
        const [reasonRows] = await mysqlPool.query(
            `SELECT descriptionId, reasonCode, COUNT(*) AS n FROM description_votes
             WHERE voteValue = 'down' AND reasonCode IS NOT NULL AND descriptionId IN (?)
             GROUP BY descriptionId, reasonCode`,
            [ids]
        );
        for (const r of reasonRows) {
            if (!reasons.has(r.descriptionId)) reasons.set(r.descriptionId, []);
            reasons.get(r.descriptionId).push({ code: r.reasonCode, label: reasonLabel(r.reasonCode), count: Number(r.n) });
        }
        const [noteRows] = await mysqlPool.query(
            `SELECT descriptionId, reasonNote FROM description_votes
             WHERE voteValue = 'down' AND reasonNote IS NOT NULL AND descriptionId IN (?)
             ORDER BY votedAt DESC`,
            [ids]
        );
        for (const n of noteRows) {
            if (!notes.has(n.descriptionId)) notes.set(n.descriptionId, []);
            const list = notes.get(n.descriptionId);
            if (list.length < 10) list.push(n.reasonNote);
        }
    }

    const descriptions = {};
    for (const r of rows) {
        descriptions[r.descriptionId] = {
            up: Number(r.upVotes || 0),
            down: Number(r.downVotes || 0),
            myVote: mine.get(r.descriptionId) || null,
            own: Boolean(accountId) && r.authorId === accountId,
            reasons: (reasons.get(r.descriptionId) || []).sort((x, y) => y.count - x.count),
            notes: notes.get(r.descriptionId) || []
        };
    }
    return {
        signedIn: Boolean(accountId),
        reasons: cfg().reasons,
        noteMaxLength: cfg().noteMaxLength,
        descriptions
    };
}

// ---------------------------------------------------------------------------
// Admin: the feedback queue
// ---------------------------------------------------------------------------

// A description needs the admin's attention when:
//   - it is hidden (down votes crossed the line), or
//   - it has ANY down vote since the admin last cleared it, or
//   - it is not primary and has enough up votes since the admin last cleared it.
const ATTENTION_SQL = `(t.hiddenAt IS NOT NULL OR t.downNew > 0 OR (t.isPrimary = 0 AND t.upNew >= ?))`;

// Each filter gets the up-vote alert threshold in force right now (admin-editable).
const FILTERS = {
    attention: (alert) => ({ sql: ATTENTION_SQL, params: [alert] }),
    hidden: () => ({ sql: 't.hiddenAt IS NOT NULL', params: [] }),
    downvoted: () => ({ sql: 't.downNew > 0', params: [] }),
    upvoted: (alert) => ({ sql: '(t.isPrimary = 0 AND t.upNew >= ?)', params: [alert] })
};

const BASE_SQL = `
    SELECT d.descriptionId, d.plantId, d.accountId AS authorId, d.isPrimary, d.hiddenAt,
           d.uses, d.benefits, d.harmful, d.createdAt,
           p.commonName, p.scientificName,
           COALESCE(NULLIF(TRIM(CONCAT_WS(' ', pr.firstName, pr.lastName)), ''), a.username) AS authorName,
           (SELECT COUNT(*) FROM description_votes v WHERE v.descriptionId = d.descriptionId AND v.voteValue = 'up'
               AND (d.feedbackClearedAt IS NULL OR v.votedAt > d.feedbackClearedAt)) AS upNew,
           (SELECT COUNT(*) FROM description_votes v WHERE v.descriptionId = d.descriptionId AND v.voteValue = 'down'
               AND (d.feedbackClearedAt IS NULL OR v.votedAt > d.feedbackClearedAt)) AS downNew,
           (SELECT COUNT(*) FROM description_votes v WHERE v.descriptionId = d.descriptionId AND v.voteValue = 'up') AS upTotal,
           (SELECT COUNT(*) FROM description_votes v WHERE v.descriptionId = d.descriptionId AND v.voteValue = 'down') AS downTotal,
           (SELECT COUNT(*) FROM plant_description o
               WHERE o.plantId = d.plantId AND o.status = 'approved' AND o.descriptionId <> d.descriptionId) AS otherCount
    FROM plant_description d
    JOIN plants p ON p.plantId = d.plantId
    JOIN accounts a ON a.accountId = d.accountId
    LEFT JOIN profiles pr ON pr.accountId = d.accountId
    WHERE d.status = 'approved' AND p.archivedAt IS NULL`;

/**
 * How many descriptions need the admin, and why (a description can be in more than one group,
 * so the groups do not add up to the total). Feeds the dashboard notification and the badges.
 */
async function countFeedback() {
    const { upvoteAlert } = await getVoteSettings();
    const [rows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(t.hiddenAt IS NOT NULL), 0) AS hidden,
                COALESCE(SUM(t.hiddenAt IS NULL AND t.downNew > 0), 0) AS downvoted,
                COALESCE(SUM(t.isPrimary = 0 AND t.upNew >= ?), 0) AS popular
         FROM (${BASE_SQL}) t WHERE ${ATTENTION_SQL}`,
        [upvoteAlert, upvoteAlert]
    );
    const r = rows[0];
    return {
        total: Number(r.total),
        hidden: Number(r.hidden),
        downvoted: Number(r.downvoted),
        popular: Number(r.popular)
    };
}

async function listFeedback({ filter, page, pageSize }) {
    const paging = parsePaging({ page, pageSize });
    const live = await getVoteSettings();
    const pick = (FILTERS[filter] || FILTERS.attention)(live.upvoteAlert);

    const [rows] = await mysqlPool.query(
        `SELECT * FROM (${BASE_SQL}) t WHERE ${pick.sql}
         ORDER BY (t.hiddenAt IS NOT NULL) DESC, t.downNew DESC, t.upNew DESC, t.createdAt ASC
         LIMIT ? OFFSET ?`,
        [...pick.params, paging.pageSize, paging.offset]
    );
    const [[count]] = await mysqlPool.query(
        `SELECT COUNT(*) AS n FROM (${BASE_SQL}) t WHERE ${pick.sql}`,
        pick.params
    );

    // Why people down-voted, for the rows on this page only: a count per premade reason, and
    // the voters' own notes (the 'other' reason) so the admin can read them without a click.
    const ids = rows.map((r) => r.descriptionId);
    const reasonMap = new Map();
    const noteMap = new Map();
    if (ids.length) {
        const [reasons] = await mysqlPool.query(
            `SELECT descriptionId, reasonCode, COUNT(*) AS n FROM description_votes
             WHERE voteValue = 'down' AND descriptionId IN (?) GROUP BY descriptionId, reasonCode`,
            [ids]
        );
        for (const r of reasons) {
            if (!reasonMap.has(r.descriptionId)) reasonMap.set(r.descriptionId, []);
            reasonMap.get(r.descriptionId).push({ code: r.reasonCode, label: reasonLabel(r.reasonCode), count: Number(r.n) });
        }
        const [notes] = await mysqlPool.query(
            `SELECT v.descriptionId, v.reasonNote, v.votedAt, a.username
             FROM description_votes v JOIN accounts a ON a.accountId = v.accountId
             WHERE v.voteValue = 'down' AND v.reasonNote IS NOT NULL AND v.descriptionId IN (?)
             ORDER BY v.votedAt DESC`,
            [ids]
        );
        for (const n of notes) {
            if (!noteMap.has(n.descriptionId)) noteMap.set(n.descriptionId, []);
            const list = noteMap.get(n.descriptionId);
            if (list.length < 5) list.push({ note: n.reasonNote, username: n.username, votedAt: n.votedAt });
        }
    }

    const alert = live.upvoteAlert;
    return {
        total: Number(count.n),
        page: paging.page,
        pageSize: paging.pageSize,
        upvoteAlert: alert,
        downvoteHide: live.downvoteHide,
        descriptions: rows.map((r) => ({
            descriptionId: r.descriptionId,
            plantId: r.plantId,
            plantName: r.commonName,
            scientificName: r.scientificName,
            authorId: r.authorId,
            authorName: r.authorName,
            isPrimary: Boolean(r.isPrimary),
            hidden: Boolean(r.hiddenAt),
            hiddenAt: r.hiddenAt,
            createdAt: r.createdAt,
            uses: r.uses,
            benefits: r.benefits,
            harmful: r.harmful,
            upNew: Number(r.upNew),
            downNew: Number(r.downNew),
            upTotal: Number(r.upTotal),
            downTotal: Number(r.downTotal),
            // Only description of its plant: taking it out removes the plant from the library.
            onlyDescription: Number(r.otherCount) === 0,
            reasons: (reasonMap.get(r.descriptionId) || []).sort((a, b) => b.count - a.count),
            notes: noteMap.get(r.descriptionId) || [],
            reasonFlags: {
                hiddenByVotes: Boolean(r.hiddenAt),
                wantsPrimary: !r.isPrimary && Number(r.upNew) >= alert
            }
        }))
    };
}

/** Every ballot on one description, with names. The ONLY place voter identities appear. */
async function listVoters(descriptionId) {
    const live = await getVoteSettings();
    const [rows] = await mysqlPool.query(
        `SELECT v.accountId, a.username, v.voteValue, v.reasonCode, v.reasonNote, v.votedAt
         FROM description_votes v JOIN accounts a ON a.accountId = v.accountId
         WHERE v.descriptionId = ?
         ORDER BY v.votedAt DESC, v.accountId ASC`,
        [descriptionId]
    );
    return {
        upvoteAlert: live.upvoteAlert,
        downvoteHide: live.downvoteHide,
        voters: rows.map((r) => ({
            accountId: r.accountId,
            username: r.username,
            value: r.voteValue,
            reasonCode: r.reasonCode,
            reasonLabel: r.reasonCode ? reasonLabel(r.reasonCode) : null,
            reasonNote: r.reasonNote,
            votedAt: r.votedAt
        }))
    };
}

// ---------------------------------------------------------------------------
// Admin: decisions
// ---------------------------------------------------------------------------

const ACTIONS = new Set(['primary', 'restore', 'dismiss', 'remove']);

/**
 * One transaction per decision, on a locked description row.
 *   primary  approved + visible description becomes THE primary one; the old primary stays
 *            as another box. Clears the alert.
 *   restore  a hidden description comes back. Its DOWN votes are deleted, because leaving
 *            them would re-hide it on the very next vote (the same rule as reinstating a
 *            discovery report); the up votes and the audit of who said what stay in the
 *            admin log.
 *   dismiss  "Keep as is": clears the alert; only newer votes raise it again. Refused for a
 *            hidden description, which has to be restored or taken out.
 *   remove   takes the description out (status 'rejected'): it leaves every public and
 *            contributor read. A primary hands over to the best remaining description.
 */
async function applyFeedbackAction(descriptionId, adminId, action) {
    if (!ACTIONS.has(action)) return fail('Unknown action', 400);

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT descriptionId, plantId, status, isPrimary, hiddenAt
             FROM plant_description WHERE descriptionId = ? FOR UPDATE`,
            [descriptionId]
        );
        if (rows.length === 0 || rows[0].status !== 'approved') {
            await conn.rollback();
            return fail('Description not found or already taken out', 404);
        }
        const d = rows[0];
        let note = '';

        if (action === 'primary') {
            if (d.hiddenAt) {
                await conn.rollback();
                return fail('This description is hidden. Restore it first, then make it primary.', 409);
            }
            await conn.query('UPDATE plant_description SET isPrimary = FALSE WHERE plantId = ?', [d.plantId]);
            await conn.query(
                'UPDATE plant_description SET isPrimary = TRUE, feedbackClearedAt = NOW() WHERE descriptionId = ?',
                [descriptionId]
            );
            note = 'Now the primary description';
        } else if (action === 'restore') {
            if (!d.hiddenAt) {
                await conn.rollback();
                return fail('This description is not hidden', 409);
            }
            await conn.query("DELETE FROM description_votes WHERE descriptionId = ? AND voteValue = 'down'", [descriptionId]);
            await conn.query(
                'UPDATE plant_description SET hiddenAt = NULL, feedbackClearedAt = NOW() WHERE descriptionId = ?',
                [descriptionId]
            );
            note = 'Restored; its down votes were cleared';
        } else if (action === 'dismiss') {
            if (d.hiddenAt) {
                await conn.rollback();
                return fail('This description is hidden. Restore it or take it out.', 409);
            }
            await conn.query('UPDATE plant_description SET feedbackClearedAt = NOW() WHERE descriptionId = ?', [descriptionId]);
            note = 'Kept as is';
        } else {
            await conn.query(
                `UPDATE plant_description
                 SET status = 'rejected', isPrimary = FALSE, reviewedBy = ?, reviewedAt = NOW()
                 WHERE descriptionId = ?`,
                [adminId, descriptionId]
            );
            if (d.isPrimary) await promoteReplacement(conn, d.plantId, descriptionId);
            note = 'Taken out';
        }

        await conn.commit();
        return { descriptionId, plantId: d.plantId, action, message: note };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = {
    normalizeVoteInput,
    castDescriptionVote,
    getVoteSummary,
    countFeedback,
    listFeedback,
    listVoters,
    applyFeedbackAction,
    applyDownvoteThreshold,
    FEEDBACK_FILTERS: Object.keys(FILTERS)
};
