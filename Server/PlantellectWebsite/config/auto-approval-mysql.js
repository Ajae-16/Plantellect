// Automatic approval.
// Split out of mysql.js; see mysql.js for the combined export list.

const approvalMode = require('./approval-mode.js');
const { mysqlPool } = require('./pool-mysql');
const { DISCOVERY_TYPE } = require('./shared-mysql');
const { claimPendingRequest, decideRoleRequest } = require('./request-mysql');
const { approvePlantRequest } = require('./approval-mysql');

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

module.exports = {
    hasPriorSubmissionDecision,
    maybeAutoResolve,
    processNewRequest
};
