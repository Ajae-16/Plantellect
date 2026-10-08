/**
 * Plant image review decisions.
 *
 * A durable record of what an admin decided about a submission, outside MySQL.
 * A rejected file is never deleted — the only feedback the submitter gets is the
 * per-request note — so the decision has to outlive the request row's note and
 * be auditable independently of it.
 *
 * Deliberately NO storedPath: this is an audit record, not a second route to a
 * private file. settings.plantImages.storageDir plus the plant_images row stays
 * the only path to bytes on disk, and the owner route in routes/plants.js stays
 * the only way to read a non-approved one.
 */
const mongoose = require('mongoose');

const settings = require('../config/settings');

/**
 * Every decision value this collection is expected to carry.
 *
 * NOT a Mongoose `enum`, on purpose. The schema's enum was ['approved','rejected']
 * while logImageReview swallowed every validation error, so the five decisions
 * the discovery loop audits — 'disqualified', 'disqualification_overridden',
 * 'claim_released', 'admin_override', 'claim_expired' — all failed validation
 * and produced NO document with no error surfaced anywhere. A swallowed write is
 * indistinguishable from a successful one, and "every override is audited" is a
 * promise this project makes in four places.
 *
 * Free text validated by the writers instead: `decision` below is a plain
 * required String, and this list is the shared contract. It is EXPORTED so
 * config/mysql.js can reject an unknown value at the call site rather than
 * discovering afterwards that the audit record vanished.
 */
const REVIEW_DECISIONS = [
    // Admin review of a plant request (config/mysql.js approvePlantRequest /
    // denyPlantRequest).
    'approved',
    'rejected',
    // The same approval, reached by the rule set instead of by a click. Its own
    // value rather than a flag on 'approved', so "which decisions did nobody look
    // at?" is a query and not an inference from a timestamp. Auto mode NEVER denies
    // anything, so there is deliberately no auto_rejected here.
    'auto_approved',
    // A single botanist's "not a plant" verdict, and any botanist overriding one.
    'disqualified',
    'disqualification_overridden',
    // A claim freed explicitly (admin, or a botanist acting on a dead claim).
    'claim_released',
    // An admin closed a report by the quorum path being unreachable.
    'admin_override',
    // A claim past claimStaleDays, actually released rather than just stale.
    'claim_expired'
];

/**
 * Who reached the decision. Free text validated by the writers, for the same
 * reason `decision` is: a Mongoose enum plus a swallowed error is how five audit
 * events vanished once already.
 *
 * 'admin'    a person clicked Approve or Deny.
 * 'system'   the fixed rule set in config/approval-mode.js.
 * 'classifier' reserved for the ML-assisted triage step this collection is being
 *             shaped for. It does not exist yet, and nothing here calls a model —
 *             but writing the field now is what makes the two eras of triage
 *             separable by a query afterwards instead of by guesswork.
 */
const DECISION_SOURCES = ['admin', 'system', 'classifier'];

const imgReviewSchema = new mongoose.Schema(
    {
        requestId: { type: String, required: true },
        // One row per decision, not per image. A text-only submission writes no
        // images, and a first-submission rail that only counted image rows would
        // leave such a submitter permanently "first".
        requestType: { type: String, default: '' },
        // Nullable for the same reason: see above.
        imageId: { type: String, default: null },
        plantId: { type: String, default: null },
        accountId: { type: String, required: true },
        decision: { type: String, required: true },
        // ---- how the decision was reached, not just who made it -------------
        // All three are free text validated by the writer, never enums, for the
        // reason REVIEW_DECISIONS is.
        //
        // 'manual' | 'auto'. Mirrors approval_requests.approvalMode, which is
        // written in the SAME transaction as the decision. This copy is the one
        // that survives the request row and is queryable together with the scan
        // feed; the SQL column is the one the admin queue reads, because
        // logImageReview swallows its own errors and a logging outage must not
        // make the UI hide a decision.
        approvalMode: { type: String, default: 'manual' },
        // 'admin' | 'system' | 'classifier'.
        decisionSource: { type: String, default: '' },
        // 'v1' for an automatic decision, empty for a manual one: no rules ran, so
        // there is no rule version to name. Bumped whenever a threshold or a rail
        // changes, so "which rules published this?" stays answerable after the
        // rules move.
        ruleVersion: { type: String, default: '' },
        // A short machine string. NEVER free text — the admin's own words live in
        // `note`, and mixing the two makes "why did the rule fire?" unanswerable.
        reason: { type: String, default: '' },
        reviewedBy: { type: String, default: '' },
        note: { type: String, default: '' },
        decidedAt: { type: Date, default: Date.now },
        expiresAt: { type: Date, required: true }
    },
    { collection: 'imgreviews' }
);

imgReviewSchema.index({ decidedAt: 1 });
imgReviewSchema.index({ decision: 1, decidedAt: -1 });
// The triage-era query: every automatic decision, in order, without touching the
// SQL request rows. This is what a future ML-assisted triage step is evaluated
// against, so it has to be cheap to ask before anyone builds it.
imgReviewSchema.index({ approvalMode: 1, decisionSource: 1, decidedAt: -1 });
imgReviewSchema.index({ accountId: 1, requestType: 1, decidedAt: -1 });
imgReviewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Imgreview = mongoose.model('Imgreview', imgReviewSchema);

/**
 * Never throws and is only ever called AFTER the transaction commits, so a
 * logging failure cannot roll back a review.
 *
 * `decision` is stored VERBATIM. This used to hardcode
 * `data.decision === 'approved' ? 'approved' : 'rejected'`, which collapsed
 * every override to 'rejected' — so even after the enum was widened the five
 * discovery decisions would all have been indistinguishable from an admin
 * rejecting a photo. The ternary is deleted rather than widened.
 */
async function logImageReview(data) {
    try {
        if (!REVIEW_DECISIONS.includes(data.decision)) {
            // Loud, but not fatal: the review itself has already committed and
            // must not be rolled back by an audit-logging mistake.
            console.error(
                `logImageReview: unknown decision "${data.decision}" (request ${data.requestId}). ` +
                'The record below is written verbatim so the audit trail stays complete.'
            );
        }
        if (data.decisionSource && !DECISION_SOURCES.includes(data.decisionSource)) {
            console.error(
                `logImageReview: unknown decisionSource "${data.decisionSource}" (request ${data.requestId}). ` +
                'The record below is written verbatim so the audit trail stays complete.'
            );
        }
        const record = new Imgreview({
            requestId: data.requestId,
            requestType: data.requestType || '',
            imageId: data.imageId || null,
            plantId: data.plantId || null,
            accountId: data.accountId,
            decision: String(data.decision),
            approvalMode: data.approvalMode || 'manual',
            decisionSource: data.decisionSource || '',
            ruleVersion: data.ruleVersion || '',
            reason: data.reason || '',
            reviewedBy: data.reviewedBy || '',
            note: data.note || '',
            decidedAt: new Date(),
            expiresAt: new Date(Date.now() + settings.ml.rejectedImageRetentionDays * 24 * 60 * 60 * 1000)
        });
        await record.save();
    } catch (err) {
        console.error('Failed to log image review:', err.message);
    }
}

module.exports = { Imgreview, imgReviewSchema, logImageReview, REVIEW_DECISIONS, DECISION_SOURCES };