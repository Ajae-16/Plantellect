// Approval: promoting a request into real content.
// Split out of mysql.js; see mysql.js for the combined export list.

const { insertRow } = require('./ids.js');
const { logImageReview } = require('../mongoose-schemas/Imgreview.js');
const approvalMode = require('./approval-mode.js');
const { mysqlPool } = require('./pool-mysql');
const { DISCOVERY_TYPE, parsePayload, normalizeScientificName, normalizeName, normalizeRichText, buildTaxonomyRow, hasAnyPartValue, DENIAL_KINDS, TAXONOMY_LEVELS, normalizeTypeSpec, createPlantType, cloneType } = require('./shared-mysql');
const { claimPendingRequest, finishRequest } = require('./request-mysql');
const { applyPlantChange } = require('./plant-manage-mysql');
const imageFiles = require('./image-files');
const relocation = require('./image-relocation');

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
 * Reads the per-photo verdicts an admin sent with an approval.
 *
 * `imageDecisions` is { [imageId]: 'approve' | 'reject' }. Absent means "approve
 * every photo the request carries" — which is what an automatic approval and any
 * older client do — so this only has to be strict when it IS present: every photo
 * in the request needs a verdict, and a verdict for a photo the request does not
 * carry is refused. Both are errors rather than quiet defaults, because "the admin
 * forgot one" and "the admin meant one" are indistinguishable afterwards, and the
 * photos are what the training set is built from.
 */
function readImageDecisions(imageIds, decisions) {
    if (decisions === undefined || decisions === null) {
        return { approve: [...imageIds], reject: [], explicit: false };
    }
    if (typeof decisions !== 'object' || Array.isArray(decisions)) {
        return { error: 'imageDecisions must be an object of imageId to approve/reject', code: 400 };
    }
    const known = new Set(imageIds);
    for (const id of Object.keys(decisions)) {
        if (!known.has(id)) return { error: `Photo ${id} is not part of this request`, code: 400 };
    }
    const approve = [];
    const reject = [];
    for (const id of imageIds) {
        const verdict = decisions[id];
        if (verdict === 'approve') approve.push(id);
        else if (verdict === 'reject') reject.push(id);
        else return { error: `Decide every photo: ${id} has no approve/reject verdict`, code: 400 };
    }
    return { approve, reject, explicit: true };
}

/**
 * Approves a plant_taxonomy request: writes the proposed levels onto the plant's
 * EXISTING taxonomy row.
 *
 * Updated in place, never inserted: plants.taxonomyId is a foreign key, so a new
 * taxonomy row would leave the old one orphaned and is exactly the duplicate this
 * request type exists to prevent. Each change carries the value it was compared
 * against when it was filed; if the row has moved since, the approval is refused
 * instead of silently overwriting whoever changed it.
 *
 * Runs inside approvePlantRequest's transaction and settles the request the same
 * way, so the audit, the contributor credit and the approvalMode column behave
 * exactly as they do for a description.
 */
async function approveTaxonomyRequest(conn, request, reviewerId, note, audit) {
    const payload = parsePayload(request.payload);
    const changes = payload.changes && typeof payload.changes === 'object' ? payload.changes : {};
    const levels = Object.keys(changes).filter((level) => TAXONOMY_LEVELS.includes(level));
    if (!request.targetPlantId || levels.length === 0) {
        await conn.rollback();
        return { error: 'This taxonomy request has no plant or no changes to apply', code: 400 };
    }

    const [rows] = await conn.query(
        `SELECT p.plantId, p.taxonomyId, tx.\`kingdom\`, tx.\`phylum\`, tx.\`class\`, tx.\`order\`, tx.\`family\`, tx.\`genus\`, tx.\`species\`
         FROM plants p JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
         WHERE p.plantId = ? FOR UPDATE`,
        [request.targetPlantId]
    );
    if (rows.length === 0) {
        await conn.rollback();
        return { error: 'The plant no longer exists', code: 404 };
    }
    for (const level of levels) {
        if (rows[0][level] !== changes[level].from) {
            await conn.rollback();
            return {
                error: `The ${level} changed from "${changes[level].from}" to "${rows[0][level]}" since this was filed. ` +
                    'Deny it and ask for a fresh request.',
                code: 409
            };
        }
    }

    // `levels` is filtered against TAXONOMY_LEVELS above, so interpolating the
    // column names here cannot be reached from request input.
    const assignments = levels.map((level) => `\`${level}\` = ?`).join(', ');
    await conn.query(
        `UPDATE taxonomy SET ${assignments} WHERE taxonomyId = ?`,
        [...levels.map((level) => changes[level].to), rows[0].taxonomyId]
    );

    const plantId = request.targetPlantId;
    await addContributorRow(conn, plantId, request.accountId, 'contributor');
    await addContributorRow(conn, plantId, reviewerId, 'reviewer');
    await finishRequest(conn, request.requestId, 'approved', reviewerId, note || null);
    await conn.commit();

    await logImageReview({
        requestId: request.requestId,
        requestType: request.requestType,
        imageId: null,
        plantId,
        accountId: request.accountId,
        decision: audit.approvalMode === 'auto' ? 'auto_approved' : 'approved',
        approvalMode: audit.approvalMode,
        decisionSource: audit.decisionSource,
        ruleVersion: audit.ruleVersion,
        reason: audit.reason,
        reviewedBy: reviewerId,
        note: note || ''
    });

    return { requestId: request.requestId, plantId, taxonomyUpdated: levels, approvalMode: audit.approvalMode };
}

/**
 * Approves a plant_change: applies each field it asks for to the plant, its
 * primary description or that description's measurements. Runs inside
 * approvePlantRequest's transaction and settles the request the same way, so the
 * audit row, the contributor credit and the approvalMode column match every other
 * type. A request whose fields moved since it was filed is refused (409).
 */
async function approvePlantChangeRequest(conn, request, reviewerId, note, audit) {
    const result = await applyPlantChange(conn, request);
    if (result.error) {
        await conn.rollback();
        return { error: result.error, code: result.code };
    }
    const plantId = result.plantId;
    await addContributorRow(conn, plantId, request.accountId, 'contributor');
    await addContributorRow(conn, plantId, reviewerId, 'reviewer');
    await finishRequest(conn, request.requestId, 'approved', reviewerId, note || null);
    await conn.commit();

    await logImageReview({
        requestId: request.requestId,
        requestType: request.requestType,
        imageId: null,
        plantId,
        accountId: request.accountId,
        decision: audit.approvalMode === 'auto' ? 'auto_approved' : 'approved',
        approvalMode: audit.approvalMode,
        decisionSource: audit.decisionSource,
        ruleVersion: audit.ruleVersion,
        reason: audit.reason,
        reviewedBy: reviewerId,
        note: note || ''
    });

    return { requestId: request.requestId, plantId, changeApplied: result.applied, approvalMode: audit.approvalMode };
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
 *
 * PHOTOS are decided one by one when `options.imageDecisions` is given (see
 * readImageDecisions); otherwise every photo in the request is approved together.
 * Each approved photo adds one to plants.quantity, which is how many approved
 * photos the species has in the training set. The count comes from the rows the
 * UPDATE actually moved out of 'pending', so approving the same request twice can
 * never count a photo twice.
 *
 * A plant_taxonomy request is routed to approveTaxonomyRequest, and a
 * plant_change to approvePlantChangeRequest.
 */
async function approvePlantRequest(requestId, reviewerId, note, options = {}) {
    const conn = await mysqlPool.getConnection();
    // Photo files follow their rows: approved photos are COPIED to
    // plants/approved/<plantId>/, rejected ones to plants/denied/<requestId>/, and
    // the old files are deleted only after the commit (see image-files.js).
    const plan = new imageFiles.FileMovePlan();
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

        if (request.requestType === 'plant_taxonomy') {
            return await approveTaxonomyRequest(
                conn,
                request,
                reviewerId,
                note,
                approvalMode.auditContextFor(reviewerId)
            );
        }

        if (request.requestType === 'plant_change') {
            return await approvePlantChangeRequest(
                conn,
                request,
                reviewerId,
                note,
                approvalMode.auditContextFor(reviewerId)
            );
        }

        const allImageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
        const verdicts = readImageDecisions(allImageIds, options.imageDecisions);
        if (verdicts.error) {
            await conn.rollback();
            return { error: verdicts.error, code: verdicts.code };
        }
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
                // The plant gets its OWN type row, made now inside the approval
                // transaction. A request filed before the per-plant model carries the
                // id of a shared row: that plant gets a private copy of it.
                let typeId;
                if (payload.typeId) {
                    typeId = await cloneType(conn, payload.typeId);
                    if (!typeId) {
                        await conn.rollback();
                        return { error: 'The plant type on this request no longer exists', code: 400 };
                    }
                } else {
                    const typeCheck = normalizeTypeSpec(payload.typeSpec);
                    if (typeCheck.errors.length > 0) {
                        await conn.rollback();
                        return { error: `Invalid plant type on this request: ${typeCheck.errors.join('; ')}`, code: 400 };
                    }
                    typeId = await createPlantType(conn, typeCheck.spec);
                }

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
                    // quantity starts at 0 and is raised by the photos approved below; it is
                    // no longer a number the botanist types.
                    [taxonomyId, typeId, commonName, scientificName, 0]
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
        const uses = normalizeRichText(payload.uses) || null;
        const benefits = normalizeRichText(payload.benefits) || null;
        const harmful = normalizeRichText(payload.harmful) || null;
        const hasDescription = Boolean(uses || benefits || harmful);
        const hasContent = hasDescription || hasParts;
        if (!hasContent && verdicts.approve.length === 0) {
            await conn.rollback();
            return {
                error: 'Nothing in this request is left to approve — every photo was rejected and it carries no text. Deny it instead.',
                code: 400
            };
        }
        if (hasContent) {
            await insertRow(
                conn,
                'plant_description',
                ['plantId', 'accountId', 'partsId', 'uses', 'benefits', 'harmful', 'status', 'isPrimary', 'reviewedBy', 'reviewedAt'],
                [plantId, submitterId, partsId, uses, benefits, harmful,
                 'approved', false, reviewerId, new Date()]
            );
        }

        // Photos. Approved ones get their plantId here (a brand-new species had
        // none while it was a request) and join the training set; rejected ones
        // keep their row, tied to the plant, so the submitter's own view can still
        // say what happened to them. `status = 'pending'` makes each UPDATE a
        // transition rather than an overwrite, and its affectedRows is the count
        // that feeds quantity.
        let approvedCount = 0;
        for (const imageId of verdicts.approve) {
            const [moved] = await conn.query(
                `UPDATE plant_images
                 SET plantId = ?, status = 'approved', reviewedBy = ?, reviewedAt = NOW()
                 WHERE imageId = ? AND accountId = ? AND status = 'pending'
                   AND (plantId = ? OR plantId IS NULL)`,
                [plantId, reviewerId, imageId, submitterId, plantId]
            );
            approvedCount += moved.affectedRows;
        }
        for (const imageId of verdicts.reject) {
            await conn.query(
                `UPDATE plant_images
                 SET plantId = ?, status = 'rejected', reviewedBy = ?, reviewedAt = NOW()
                 WHERE imageId = ? AND accountId = ? AND status = 'pending'
                   AND (plantId = ? OR plantId IS NULL)`,
                [plantId, reviewerId, imageId, submitterId, plantId]
            );
        }
        if (approvedCount > 0) {
            await conn.query(
                'UPDATE plants SET quantity = COALESCE(quantity, 0) + ? WHERE plantId = ?',
                [approvedCount, plantId]
            );
        }

        // The files now follow the rows. A photo that cannot be copied cleanly
        // keeps its old path and is flagged for the admin (fileIssue); it never
        // blocks the approval, which is a decision about the content.
        const photoMoves = [
            await relocation.relocatePlantImages(conn, plan, {
                imageIds: verdicts.approve, status: 'approved', requestId, plantId
            }),
            await relocation.relocatePlantImages(conn, plan, {
                imageIds: verdicts.reject, status: 'rejected', requestId, plantId
            })
        ];
        const photoFileProblems = photoMoves.flatMap((m) => m.failed);
        if (verdicts.reject.length > 0) {
            const photoNote = `[system] Photos: ${verdicts.approve.length} approved, ${verdicts.reject.length} not approved.`;
            noteText = noteText ? `${noteText}\n\n${photoNote}` : photoNote;
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
                // The report is approved, so its photos move to discoveries/approved/.
                const reportMoves = await relocation.relocateDiscoveryImages(
                    conn, plan, payload.discoveryRequestId, 'approved'
                );
                photoFileProblems.push(...reportMoves.failed);
                discoveryClosed = { requestId: payload.discoveryRequestId, reporterId, plantId };
            }
        }

        await ensurePrimaryContent(conn, plantId);
        await finishRequest(conn, requestId, 'approved', reviewerId, noteText);

        await conn.commit();
        // The rows now point at the verified copies: delete the old files.
        await plan.finalize();
        relocation.tidyAfter(plan);

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

        // One extra audit row per photo, only when the admin decided them one by
        // one — that is the case where "which photo, and who said so" is the
        // question. A bulk approval keeps its single per-request row.
        if (verdicts.explicit) {
            for (const imageId of allImageIds) {
                await logImageReview({
                    requestId,
                    requestType: request.requestType,
                    imageId,
                    plantId,
                    accountId: submitterId,
                    decision: verdicts.approve.includes(imageId)
                        ? (audit.approvalMode === 'auto' ? 'auto_approved' : 'approved')
                        : 'rejected',
                    approvalMode: audit.approvalMode,
                    decisionSource: audit.decisionSource,
                    ruleVersion: audit.ruleVersion,
                    reason: audit.reason,
                    reviewedBy: reviewerId,
                    note: noteText || ''
                });
            }
        }

        return {
            requestId,
            plantId,
            converted,
            discoveryClosed,
            approvalMode: audit.approvalMode,
            photosApproved: approvedCount,
            photosRejected: verdicts.reject.length,
            quantityAdded: approvedCount,
            // Non-empty only when a photo could not be copied cleanly after the
            // retry limit. The approval stands; the admin sees these on the plants page.
            photoFileProblems
        };
    } catch (err) {
        await conn.rollback();
        await plan.rollback();
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
    const plan = new imageFiles.FileMovePlan();
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
        // Denied photos move from plants/pending/ to plants/denied/<requestId>/.
        const photoMoves = await relocation.relocatePlantImages(conn, plan, {
            imageIds, status: 'rejected', requestId
        });
        const photoFileProblems = [...photoMoves.failed];
        // plant_taxonomy and plant_change carry a targetPlantId but no content of their
        // own. Without this guard, denying one would also reject the same botanist's
        // unrelated pending descriptions and measurements on that plant.
        const carriesNoContent = request.requestType === 'plant_taxonomy' || request.requestType === 'plant_change';
        if (request.targetPlantId && !carriesNoContent) {
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
            if (result.affectedRows > 0) {
                discoveryDenied = payload.discoveryRequestId;
                // The species was refused, so the report's photos go to discoveries/denied/.
                const reportMoves = await relocation.relocateDiscoveryImages(
                    conn, plan, payload.discoveryRequestId, 'denied'
                );
                photoFileProblems.push(...reportMoves.failed);
            }
        }

        await finishRequest(conn, requestId, 'denied', reviewerId, note);
        await conn.commit();
        await plan.finalize();
        relocation.tidyAfter(plan);

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

        return { requestId, kind, discoveryDenied, approvalMode: audit.approvalMode, photoFileProblems };
    } catch (err) {
        await conn.rollback();
        await plan.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = {
    approvePlantRequest,
    denyPlantRequest
};
