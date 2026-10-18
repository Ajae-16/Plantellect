// Approval: promoting a request into real content.
// Split out of mysql.js; see mysql.js for the combined export list.

const { insertRow } = require('./ids.js');
const { logImageReview } = require('../mongoose-schemas/Imgreview.js');
const approvalMode = require('./approval-mode.js');
const { mysqlPool } = require('./pool-mysql');
const { DISCOVERY_TYPE, parsePayload, normalizeScientificName, normalizeName, buildTaxonomyRow, hasAnyPartValue, DENIAL_KINDS } = require('./shared-mysql');
const { claimPendingRequest, finishRequest } = require('./request-mysql');

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

module.exports = {
    approvePlantRequest,
    denyPlantRequest
};
