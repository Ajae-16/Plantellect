// Pending approvals for the signed-in account (the Profile > Pending approval tab and the
// sidebar's "Profile (n)" badge).
//
//   awaitingMe   change requests that need MY answer (a change to a description I wrote, or to the plant info
//                of a plant I am the primary contributor of), then the ones I already answered or that were
//                decided meanwhile
//   mine         change requests I filed: the open ones first, then the approved / denied ones
//
// Both lists put what still needs an approval on top and what is already approved or denied at the
// bottom. A denied request is deleted after settings.maintenance.deniedChangeRetentionDays days
// (config/denied-change-purge.js); an answered one leaves my awaitingMe list after the same time.
//
// The contributor's answer is stored in the request's payload (see owner-approval.js), so there is
// no table of its own. Approving only records the answer; the request stays pending for the admin.
// Declining ends the request (status 'denied').
//
// What counts as NEW (the number next to Profile):
//   + every request waiting for my answer, until I answer it
//   + every request of mine whose state changed since I last opened the tab
//     (payload.requesterSeenState differs from the state it is in now)

const { mysqlPool } = require('./pool-mysql');
const { parsePayload } = require('./shared-mysql');
const { claimPendingRequest, finishRequest } = require('./request-mysql');
const settings = require('./settings');
const { publicUrls, visibleImageSql } = require('./public-images');
const { ownerApprovalOf, stateOf, OWNER_PENDING, OWNER_APPROVED, OWNER_DENIED } = require('./owner-approval');

const MAX_NOTE = 300;
const MINE_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When a request was decided (or filed, when no decision time was stored): the key for newest-first order. */
function decidedAtMs(row) {
    const t = new Date(row.reviewedAt || row.createdAt).getTime();
    return Number.isFinite(t) ? t : 0;
}

function personName(row, prefix) {
    const full = [row[`${prefix}FirstName`], row[`${prefix}LastName`]].filter(Boolean).join(' ');
    return full || row[`${prefix}Username`] || 'Someone';
}

function changeShape(payload) {
    return {
        scope: payload.scope || 'legacy',
        descriptionId: payload.descriptionId || null,
        reason: payload.reason || null,
        changes: payload.changes && typeof payload.changes === 'object' ? payload.changes : {}
    };
}

/**
 * Requests sent to ME. The ones that still need my answer come first (oldest first); after them the ones I
 * already answered or that an admin settled meanwhile (newest first), each with its state.
 */
async function loadAwaiting(accountId) {
    const keepSince = new Date(Date.now() - settings.maintenance.deniedChangeRetentionDays * DAY_MS);
    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.accountId, ar.targetPlantId, ar.payload, ar.status, ar.createdAt, ar.reviewedAt,
                a.username AS requesterUsername, pr.firstName AS requesterFirstName, pr.lastName AS requesterLastName,
                p.commonName AS plantName, p.scientificName AS plantScientificName,
                (SELECT i.imageId FROM plant_images i
                 WHERE i.plantId = p.plantId AND ${visibleImageSql('i')}
                 ORDER BY i.isPrimary DESC, i.uploadedAt ASC LIMIT 1) AS heroImageId
         FROM approval_requests ar
         JOIN accounts a ON a.accountId = ar.accountId
         LEFT JOIN profiles pr ON pr.accountId = ar.accountId
         LEFT JOIN plants p ON p.plantId = ar.targetPlantId
         WHERE ar.requestType = 'plant_change' AND ar.status <> 'cancelled'
           AND (ar.status = 'pending' OR COALESCE(ar.reviewedAt, ar.createdAt) >= ?)
         ORDER BY ar.createdAt ASC`,
        [keepSince]
    );
    const open = [];
    const settled = [];
    for (const r of rows) {
        const payload = parsePayload(r.payload);
        const oa = ownerApprovalOf(payload);
        if (!oa || oa.ownerId !== accountId) continue;
        // Needs my answer: nobody has settled the request and I have not answered it.
        const needsAnswer = r.status === 'pending' && oa.status === OWNER_PENDING;
        const item = {
            requestId: r.requestId,
            plantId: r.targetPlantId,
            plantName: r.plantName,
            scientificName: r.plantScientificName,
            imageUrl: publicUrls(r.targetPlantId, r.heroImageId).imageUrl,
            requesterId: r.accountId,
            requesterName: personName(r, 'requester'),
            createdAt: r.createdAt,
            reviewedAt: r.reviewedAt,
            status: r.status,                 // pending | approved | denied (the request as a whole)
            ownerStatus: oa.status,           // my own answer: pending | approved | denied
            ownerNote: oa.note || null,
            ownerDecidedAt: oa.decidedAt || null,
            needsAnswer,
            _sort: decidedAtMs(r),
            ...changeShape(payload)
        };
        (needsAnswer ? open : settled).push(item);
    }
    settled.sort((x, y) => y._sort - x._sort);
    return [...open, ...settled].map(({ _sort, ...rest }) => rest);
}

/** Requests I filed: still pending, or decided / answered since I last looked. */
async function loadMine(accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.targetPlantId, ar.payload, ar.status, ar.createdAt, ar.reviewedAt, ar.note,
                p.commonName AS plantName, p.scientificName AS plantScientificName,
                (SELECT i.imageId FROM plant_images i
                 WHERE i.plantId = p.plantId AND ${visibleImageSql('i')}
                 ORDER BY i.isPrimary DESC, i.uploadedAt ASC LIMIT 1) AS heroImageId
         FROM approval_requests ar
         LEFT JOIN plants p ON p.plantId = ar.targetPlantId
         WHERE ar.requestType = 'plant_change' AND ar.accountId = ?
         ORDER BY ar.createdAt DESC
         LIMIT ${MINE_LIMIT}`,
        [accountId]
    );
    const out = [];
    for (const r of rows) {
        if (r.status === 'cancelled') continue;
        const payload = parsePayload(r.payload);
        const state = stateOf(r.status, payload);
        // Older requests carry no seen-state: treat them as already seen so nothing floods the badge.
        const unread = payload.requesterSeenState !== undefined && payload.requesterSeenState !== state;
        // A decided request stays (at the bottom) until it is deleted: a denied one after the retention days.
        const oa = ownerApprovalOf(payload);
        out.push({
            requestId: r.requestId,
            plantId: r.targetPlantId,
            plantName: r.plantName,
            scientificName: r.plantScientificName,
            imageUrl: publicUrls(r.targetPlantId, r.heroImageId).imageUrl,
            status: r.status,                 // pending | approved | denied
            createdAt: r.createdAt,
            reviewedAt: r.reviewedAt,
            note: r.note,
            unread,
            owner: oa ? {
                id: oa.ownerId, name: oa.ownerName || 'the contributor',
                role: oa.role || null,        // 'primary' = the plant's primary contributor (a plant-info change)
                status: oa.status, decidedAt: oa.decidedAt || null, note: oa.note || null
            } : null,
            ...changeShape(payload),
            _state: state,
            _sort: decidedAtMs(r)
        });
    }
    // Still open on top (newest first), then approved / denied (most recently decided first).
    const isOpen = (x) => x.status === 'pending';
    out.sort((x, y) => (isOpen(x) === isOpen(y)
        ? y._sort - x._sort
        : (isOpen(x) ? -1 : 1)));
    return out;
}

async function getApprovals(accountId) {
    const [awaitingMe, mine] = await Promise.all([loadAwaiting(accountId), loadMine(accountId)]);
    const badge = awaitingMe.filter((a) => a.needsAnswer).length + mine.filter((m) => m.unread).length;
    return {
        awaitingMe,
        mine: mine.map(({ _state, _sort, ...rest }) => rest),
        badge
    };
}

/** Just the number, for the sidebar. */
async function getBadgeCount(accountId) {
    const { badge } = await getApprovals(accountId);
    return badge;
}

/** The requester opened the tab: everything they can see now counts as seen. */
async function markSeen(accountId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT requestId, status, payload FROM approval_requests
             WHERE requestType = 'plant_change' AND accountId = ? AND status <> 'cancelled'
             ORDER BY createdAt DESC LIMIT ${MINE_LIMIT} FOR UPDATE`,
            [accountId]
        );
        let changed = 0;
        for (const r of rows) {
            const payload = parsePayload(r.payload);
            if (payload.requesterSeenState === undefined) continue;
            const state = stateOf(r.status, payload);
            if (payload.requesterSeenState === state) continue;
            payload.requesterSeenState = state;
            await conn.query('UPDATE approval_requests SET payload = ? WHERE requestId = ?', [JSON.stringify(payload), r.requestId]);
            changed += 1;
        }
        await conn.commit();
        return { marked: changed };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * The contributor answers a change request to their own description.
 * decision: 'approve' | 'deny'. Someone else's request id answers 404, like everywhere else.
 */
async function decideAsOwner(accountId, requestId, decision, rawNote) {
    if (decision !== 'approve' && decision !== 'deny') return { error: 'decision must be approve or deny', code: 400 };
    const note = String(rawNote || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const request = await claimPendingRequest(conn, requestId);   // pending only, row locked
        if (!request || request.requestType !== 'plant_change') {
            await conn.rollback();
            return { error: 'Request not found, or it has already been decided', code: 404 };
        }
        const payload = parsePayload(request.payload);
        const oa = ownerApprovalOf(payload);
        if (!oa || oa.ownerId !== accountId) {
            await conn.rollback();
            return { error: 'Request not found, or it has already been decided', code: 404 };
        }
        if (oa.status !== OWNER_PENDING) {
            await conn.rollback();
            return { error: 'You have already answered this request', code: 409 };
        }

        oa.status = decision === 'approve' ? OWNER_APPROVED : OWNER_DENIED;
        oa.decidedAt = new Date().toISOString();
        oa.note = note || null;
        payload.ownerApproval = oa;
        await conn.query('UPDATE approval_requests SET payload = ? WHERE requestId = ?', [JSON.stringify(payload), requestId]);

        if (decision === 'deny') {
            // Declined by the author: the request ends here and the admin never has to look at it.
            await finishRequest(conn, requestId, 'denied', accountId, `[contributor declined]${note ? ' ' + note : ''}`);
        }
        await conn.commit();
        return {
            requestId,
            ownerStatus: oa.status,
            // approve: still waiting for the admin; deny: finished
            status: decision === 'deny' ? 'denied' : 'pending'
        };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = { getApprovals, getBadgeCount, markSeen, decideAsOwner };
