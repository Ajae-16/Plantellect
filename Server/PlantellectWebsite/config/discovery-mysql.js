// Discovery reports.
// Split out of mysql.js; see mysql.js for the combined export list.

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const settings = require('./settings');
const { insertRow } = require('./ids.js');
const { logImageReview } = require('../mongoose-schemas/Imgreview.js');
const { resolveSetting, resolveLimit } = require('./limits.js');
const { mysqlPool } = require('./pool-mysql');
const { DISCOVERY_TYPE, normalizeScientificName, normalizeName, parsePaging, parsePayload } = require('./shared-mysql');
const imageFiles = require('./image-files');
const relocation = require('./image-relocation');

// ---------------------------------------------------------------------------
// Discovery reports
//
// A `user` flags a plant the model could not identify. A botanist claims it,
// records it, and an admin approves the record — which is what closes the
// report. Everything below is keyed on requestType = 'plant_discovery'.
// ---------------------------------------------------------------------------

/**
 * "Not a plant" reasons, a CLOSED set and never free text.
 *
 * The value reaches the UI as a label, so an unvalidated one here is an
 * injection surface; it also lands in a VARCHAR(32) audit column that nobody
 * could later check for sense.
 */
const DISQUALIFY_REASONS = [
    'not_a_plant',
    'not_a_photo_of_plant',
    'unusable_image',
    'already_recorded',
    'duplicate'
];

const DISCOVERY_NOTE = 'A note or at least one photo is required.';

/** Shared body text for "you are at a limit", so both caps read identically. */
const CLAIM_SLOT_RETRY_HINT =
    'Release or resolve one of your claims to free a slot, or wait for a report to be decided.';
const OPEN_REPORT_RETRY_HINT =
    'Wait for one of your open reports to be reviewed, or cancel one.';

/**
 * The discovery storage root. Under settings.plantImages.storageDir on purpose:
 * nothing new is statically served, and the shared fileFilter and maxSizeBytes
 * apply unchanged, so a report cannot become a way to upload something the
 * library would reject.
 */
const DISCOVERY_STORAGE_ROOT = path.join(
    settings.plantImages.storageDir,
    settings.plantImages.discoverySubdir
);

/** A claim older than this is not a reservation any more  */
function staleClaimCutoff() {
    return new Date(Date.now() - settings.discoveries.claimStaleDays * 24 * 60 * 60 * 1000);
}

/**
 * A CLAIM is live when its holder can still authenticate and the claim is
 * inside the staleness window. Computed in SQL so the truth holds between
 * sweeps, not only after prune-usage.cjs has run.
 *
 * `holder` is the LEFT JOIN alias for the claiming account.
 */
function claimIsLive(holderAlias) {
    return `(${holderAlias}.status = 'active' AND ar.claimedBy IS NOT NULL
            AND ar.claimedAt IS NOT NULL AND ar.claimedAt > ?)`;
}

/**
 * ONE definition of the electorate: active, holds record_plant, and is NOT a
 * privileged role.
 *
 * Reused by the threshold, the queue card's "N of M", dispatch eligibility and
 * the vote itself. If the card says "3 of 5" while the vote check computes 4,
 * the botanist is shown a number that can never be reached and the report is
 * unclosable — same discipline as parsePaging.
 *
 * The plan writes this as "active AND holds record_plant", which on this seed
 * data also counts superadmin and admin — they hold every permission. That is
 * excluded here, for two reasons that both come from the plan itself:
 *   - the card LABELS these accounts "botanists", and an administrator is not one
 *     (sidebar canDiscover is `record_plant && !isAdmin`);
 *   - a quorum exists so "more than one opinion" is needed before the community
 *     disposes of a user's report. Counting admins puts an administrator inside
 *     that electorate, so one admin plus one botanist satisfies a threshold of 2
 *     and the veto is exercised by a single botanist's opinion.
 * With the seeded data (exactly one botanist, acc_000002) this is what makes
 * /vote refuse with 409 and leaves the admin override as the only closure path.
 */
async function countActiveBotanists(conn) {
    const target = conn || mysqlPool;
    const [rows] = await target.query(
        `SELECT COUNT(*) AS n
         FROM accounts a
         JOIN role_permissions rp ON rp.roleId = a.roleId
         JOIN permissions p ON p.permissionId = rp.permissionId AND p.permissionName = 'record_plant'
         WHERE a.status = 'active'
           AND NOT EXISTS (
               SELECT 1 FROM role_permissions ap
               JOIN permissions apm ON apm.permissionId = ap.permissionId
               WHERE ap.roleId = a.roleId AND apm.permissionName = 'access_admin'
           )`
    );
    return Number(rows[0].n);
}

/**
 * The setting is a CEILING, not the quorum.
 *
 * A fixed number against a variable electorate changes meaning as people join or
 * leave: "5" is unanimity with five botanists and a majority with ten. So the
 * effective threshold is max(2, min(ceiling, ceil(activeBotanists / 2))) — always
 * "more than one opinion" and never "everybody".
 *
 * The floor of 2 is not optional: ceil(n / 2) alone gives 1 for one botanist and
 * 1 for two, so a single person could close every report alone.
 */
function effectiveNotAPlantThreshold(activeBotanists) {
    const ceiling = settings.discoveries.notAPlantVotes;
    return Math.max(2, Math.min(ceiling, Math.ceil(activeBotanists / 2)));
}

/** Live claims held by one botanist: the cap count. */
async function countLiveClaims(conn, accountId) {
    const [rows] = await conn.query(
        `SELECT COUNT(*) AS n
         FROM approval_requests ar
         JOIN accounts holder ON holder.accountId = ar.claimedBy
         WHERE ar.requestType = ?
           AND ar.claimedBy = ?
           AND ar.status = 'pending'
           AND ar.resolvedBy IS NULL
           AND ar.disqualifiedBy IS NULL`,
        [DISCOVERY_TYPE, accountId]
    );
    return Number(rows[0].n);
}

/**
 * A report is CLAIMABLE when its own status is still pending, the record it
 * produced is not under review, and no live claim holds it.
 *
 * Both terms are load-bearing, and the predicate is written out at each call site
 * rather than assembled here: the claim path needs it inside a conditional
 * UPDATE with a lock in front of it, and the count path needs it inside a SUM.
 * Sharing one builder across the two would hide the fact that the UPDATE needs
 * `holder` joined and the SUM needs it LEFT joined.
 *
 * Without the status term a report closed by approval or by a `reject` denial
 * would be claimable again, because its linked record is `denied` and therefore
 * no longer `pending`. Without the linked-record term a `revise`-denied report
 * would be stranded: the species was not added, so the report is live work and
 * must be recordable again.
 */

/** Shared photo read for one report. Batch callers use
 * listDiscoveryImagesForRequests instead of looping this per card. */
async function listDiscoveryImagesForRequests(requestIds) {
    const map = new Map();
    if (!requestIds.length) return map;
    const [rows] = await mysqlPool.query(
        `SELECT requestId, imageId, originalFilename, mimeType, size, uploadedAt
         FROM discovery_images
         WHERE requestId IN (${requestIds.map(() => '?').join(',')})
         ORDER BY uploadedAt ASC, imageId ASC`,
        requestIds
    );
    for (const row of rows) {
        if (!map.has(row.requestId)) map.set(row.requestId, []);
        map.get(row.requestId).push(row);
    }
    return map;
}

/** A feature switch in system_settings (moved from rbac_meta in M27a). An absent key is off, never an error. */
async function getDiscoveryFeatureFlag(key) {
    const value = await resolveSetting(mysqlPool, key);
    return value === 1 || value === '1' || value === true ? '1' : '0';
}

/** Normalises what the client sent as predictions into the stored shape. */
function normalizePredictionList(predictions) {
    if (!Array.isArray(predictions)) return [];
    return predictions
        .filter((p) => p && (p.scientificName || p.scientific_name))
        .slice(0, 10)
        .map((p) => ({
            scientificName: normalizeScientificName(p.scientificName || p.scientific_name),
            commonName: normalizeName(p.commonName || p.common_name),
            confidence: typeof p.confidence === 'number' ? p.confidence : 0
        }))
        .filter((p) => p.scientificName);
}

/** system_settings is where feature switches live, so the flag is readable without a deploy. */
async function isAutoDispatchEnabled() {
    return (await getDiscoveryFeatureFlag('discovery_auto_dispatch')) === '1';
}

/**
 *  mark the scans a report came from, so an analytical consumer can
 * tell "people scan this and it is missing" from "people scan this, flagged it,
 * and a botanist is on it".
 *
 * By scientificName plus a recent window, because mlscans lives in Mongo and
 * approval_requests in MySQL — there is no cross-database foreign key to hang
 * this on, and inventing one is not possible.
 */
async function markRecentScansReported(accountId, scientificNames) {
    if (!scientificNames || scientificNames.length === 0) return 0;
    const { Mlscan } = require('../mongoose-schemas/Mlscan.js');
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await Mlscan.updateMany(
        {
            accountId,
            createdAt: { $gte: since },
            'predictions.scientificName': { $in: scientificNames }
        },
        { $set: { reported: true } }
    );
    return result.modifiedCount || 0;
}

/**
 * assign a new report to the least-loaded active botanist.
 *
 * NOT machine approval: the dispatched report still needs a human claim
 * decision and its closure is still the record's approval. What it fixes is that
 * unclaimed reports otherwise sit with nobody.
 *
 * Called inside the caller's transaction so a dispatch can never outlive the
 * report it was assigned to.
 */
async function dispatchDiscovery(conn, requestId) {
    if (!(await isAutoDispatchEnabled())) return null;

    const botanists = await listEligibleDispatchTargets(conn);
    if (botanists.length === 0) return null;

    const [result] = await conn.query(
        `UPDATE approval_requests ar
         SET ar.claimedBy = ?, ar.claimedAt = NOW(), ar.claimSource = 'auto'
         WHERE ar.requestId = ?
           AND ar.requestType = '${DISCOVERY_TYPE}'
           AND ar.status = 'pending'
           AND ar.claimedBy IS NULL`,
        [botanists[0].accountId, requestId]
    );
    return result.affectedRows > 0 ? botanists[0].accountId : null;
}

/**
 * Dispatch eligibility, in one place.
 *
 * Skips anyone at the claim cap (the queue is genuinely full, so leaving the
 * report unclaimed and letting the sidebar dot count it is the correct outcome)
 * and anyone whose oldest live claim is older than claimStaleDays — without that
 * second rule "least loaded" quietly means "whoever was assigned last", and an
 * absent botanist accumulates claims until the queue is theirs.
 */
async function listEligibleDispatchTargets(conn) {
    const max = settings.discoveries.maxClaimsPerBotanist;
    const cutoff = staleClaimCutoff();
    // Same electorate as countActiveBotanists: dispatch assigns work, so handing
    // it to an administrator would be "least loaded" only because they never
    // claim anything by hand.
    const [rows] = await conn.query(
        `SELECT a.accountId,
                (SELECT COUNT(*) FROM approval_requests c
                  WHERE c.requestType = ? AND c.claimedBy = a.accountId
                    AND c.status = 'pending'
                    AND c.resolvedBy IS NULL
                    AND c.disqualifiedBy IS NULL) AS liveClaims,
                (SELECT MIN(c.claimedAt) FROM approval_requests c
                  WHERE c.requestType = ? AND c.claimedBy = a.accountId
                    AND c.status = 'pending'
                    AND c.resolvedBy IS NULL
                    AND c.disqualifiedBy IS NULL) AS oldestClaim
         FROM accounts a
         WHERE a.status = 'active'
           AND EXISTS (
               SELECT 1 FROM role_permissions rp
               JOIN permissions p ON p.permissionId = rp.permissionId
               WHERE rp.roleId = a.roleId AND p.permissionName = 'record_plant'
           )
           AND NOT EXISTS (
               SELECT 1 FROM role_permissions ap
               JOIN permissions apm ON apm.permissionId = ap.permissionId
               WHERE ap.roleId = a.roleId AND apm.permissionName = 'access_admin'
           )
         ORDER BY a.accountId ASC`,
        [DISCOVERY_TYPE, DISCOVERY_TYPE]
    );
    return rows
        .filter((r) => Number(r.liveClaims) < max)
        // An absent botanist stops being eligible rather than being handed more.
        .filter((r) => !r.oldestClaim || new Date(r.oldestClaim) > cutoff)
        // Fewest live claims, ties broken by lowest accountId so the result is
        // deterministic and testable.
        .sort((x, y) => Number(x.liveClaims) - Number(y.liveClaims) ||
            x.accountId.localeCompare(y.accountId));
}

/**
 * Helper: formats a retry delay in seconds to a human-readable string.
 */
function formatRetryDelay(seconds) {
    if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Helper: formats seconds ago to minutes ago string.
 */
function formatMinutesAgo(seconds) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * creates the report, its photos, and (when the switch is on) its claim.
 *
 * One transaction, and the folder is created ONLY AFTER the request row exists �
 * so the directory is keyed by a real requestId rather than anything
 * client-supplied, the same rule createPlantContributionRequest follows with
 * plantId. On any failure the moved files are unlinked and the now-empty folder
 * removed, so a rolled-back report leaves no orphan bytes and no stray directory.
 */
async function createDiscoveryReport({ accountId, note, location, predictions, files }) {
    const cleanNote = normalizeName(note);
    const cleanLocation = normalizeName(location);
    const cleanPredictions = normalizePredictionList(predictions);
    const accepted = Array.isArray(files) ? files : [];

    if (!cleanNote && accepted.length === 0) {
        return { error: DISCOVERY_NOTE, code: 400 };
    }
    if (accepted.length > settings.plantImages.maxDiscoveryFiles) {
        return {
            error: `At most ${settings.plantImages.maxDiscoveryFiles} photos per report.`,
            code: 400
        };
    }

    const conn = await mysqlPool.getConnection();
    const plan = new imageFiles.FileMovePlan();
    let createdDir = null;
    try {
        await conn.beginTransaction();

        // Lock the account row FIRST � the same lock claimDiscovery takes. This is
        // what makes the open-report cap atomic: a bare count-then-insert lets two
        // rapid submissions both read 9 and both succeed at 10.
        const [accountRows] = await conn.query(
            'SELECT accountId, roleId FROM accounts WHERE accountId = ? FOR UPDATE',
            [accountId]
        );
        if (accountRows.length === 0) {
            await conn.rollback();
            return { error: 'Account not found', code: 404 };
        }
        const roleId = accountRows[0]?.roleId;

        // COOLDOWN BEFORE CAP, in a fixed order. A user can be both cooled down and
        // at their limit, and the client renders one message: the cooldown is the
        // more immediate reason and its 429 carries a Retry-After the header can
        // express directly.
        const cooldown = settings.discoveries.reportCooldownMinutes;
        if (cooldown > 0) {
            const [recent] = await conn.query(
                `SELECT TIMESTAMPDIFF(SECOND, createdAt, NOW()) AS secondsAgo
                 FROM approval_requests
                 WHERE accountId = ? AND requestType = ?
                 ORDER BY createdAt DESC LIMIT 1`,
                [accountId, DISCOVERY_TYPE]
            );
            if (recent.length > 0 && Number(recent[0].secondsAgo) < cooldown * 60) {
                const retryAfter = Math.max(1, cooldown * 60 - Number(recent[0].secondsAgo));
                await conn.rollback();
                return {
                    error: `You filed a report ${formatMinutesAgo(cooldown * 60 - retryAfter)} ago. ` +
                        `Try again in ${formatRetryDelay(retryAfter)}.`,
                    code: 429,
                    retryAfterSeconds: retryAfter
                };
            }
        }

        const [openRows] = await conn.query(
            `SELECT COUNT(*) AS n FROM approval_requests
             WHERE accountId = ? AND requestType = ? AND status = 'pending'`,
            [accountId, DISCOVERY_TYPE]
        );
        const openReports = Number(openRows[0].n);
        // Resolve maxOpenReportsPerAccount from role_limits -> system_settings -> settings.js
        let maxOpenReports;
        if (roleId) {
            const resolved = await resolveLimit(conn, 'maxOpenReportsPerAccount', roleId);
            maxOpenReports = typeof resolved === 'object' ? resolved.maxOpenReportsPerAccount : resolved;
        }
        if (!maxOpenReports) maxOpenReports = settings.discoveries.maxOpenReportsPerAccount;

        if (openReports >= maxOpenReports) {
            await conn.rollback();
            // 409, not 429: a conflict with the caller's own outstanding state,
            // not a frequency limit. One response shape for "you are at a limit".
            return {
                error: OPEN_REPORT_RETRY_HINT,
                code: 409,
                openReports,
                maxOpenReports
            };
        }

        const requestId = await insertRow(
            conn,
            'approval_requests',
            ['accountId', 'requestType', 'payload', 'status'],
            [
                accountId,
                DISCOVERY_TYPE,
                JSON.stringify({ note: cleanNote || null, location: cleanLocation || null, predictions: cleanPredictions }),
                'pending'
            ]
        );

        let imageIds = [];
        if (accepted.length > 0) {
            // A new report is PENDING, so its photos start in discoveries/pending/<requestId>/.
            const relativeDir = imageFiles.discoveryRelativeDir('pending', requestId);
            createdDir = path.join(DISCOVERY_STORAGE_ROOT, relativeDir);
            if (!fs.existsSync(createdDir)) fs.mkdirSync(createdDir, { recursive: true });

            for (const file of accepted) {
                const ext = path.extname(file.originalname).toLowerCase();
                // Never reuse the client-supplied name on disk.
                const storedFilename = `${crypto.randomUUID()}${ext}`;
                const relativePath = path.join(relativeDir, storedFilename);
                const destination = path.join(DISCOVERY_STORAGE_ROOT, relativePath);
                // COPY, verify, and delete the temp upload only after the commit.
                const copied = await plan.stage(file.path, destination, { mimeType: file.mimetype });
                if (!copied.ok) {
                    const failure = new Error(
                        `The photo "${file.originalname}" could not be saved cleanly after ${copied.attempts || 1} attempts ` +
                        `(${copied.error}). Nothing was submitted. Please try again.`
                    );
                    failure.userFacing = true;
                    failure.code = 500;
                    throw failure;
                }
                imageIds.push(await insertRow(
                    conn,
                    'discovery_images',
                    ['requestId', 'accountId', 'originalFilename', 'storedPath', 'mimeType', 'size'],
                    [requestId, accountId, file.originalname, relativePath, file.mimetype, file.size]
                ));
            }
        }

        const dispatchedTo = await dispatchDiscovery(conn, requestId);

        await conn.commit();
        await plan.finalize();

        // After the commit: Mongo is not in the transaction and must never be able
        // to fail the report.
        markRecentScansReported(
            accountId,
            cleanPredictions.map((p) => p.scientificName)
        ).catch((err) => console.error('Could not flag scans as reported:', err.message));

        return { requestId, imageIds, openReports: openReports + 1, maxOpenReports, dispatchedTo };
    } catch (err) {
        await conn.rollback();
        await plan.rollback();
        if (createdDir) {
            // Removes the request's own folder only; the pending/approved/denied
            // folders themselves stay.
            imageFiles.pruneEmptyDirs(createdDir, path.dirname(createdDir));
        }
        if (err && err.userFacing) return { error: err.message, code: err.code };
        throw err;
    } finally {
        conn.release();
    }
}async function getDiscoveryImageForOwner(imageId, accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT imageId, requestId, accountId, originalFilename, storedPath, mimeType, size
         FROM discovery_images WHERE imageId = ? AND accountId = ?`,
        [imageId, accountId]
    );
    return rows[0] || null;
}

/**
 *  the botanist's view. Status-free, because a botanist must be able to
 * read the photo they are being asked to judge. Admin-only is NOT assumed here —
 * routes/discoveries.js gates it on record_plant, and routes/admin.js uses
 * getDiscoveryImageForReview below.
 */
async function getDiscoveryImageForBotanist(imageId) {
    const [rows] = await mysqlPool.query(
        `SELECT imageId, requestId, accountId, originalFilename, storedPath, mimeType, size, uploadedAt
         FROM discovery_images WHERE imageId = ?`,
        [imageId]
    );
    return rows[0] || null;
}

/** the admin review route, status-free and never cached. */
async function getDiscoveryImageForReview(imageId) {
    return getDiscoveryImageForBotanist(imageId);
}

/**
 * the botanist queue.
 *
 * NEVER filtered by claim — a claimed report stays visible, carrying who has it
 * and when. Only `status = 'pending'` filters, which is why a report closed by
 * approval  or by a `reject` denial leaves the queue for
 * good, and a `revise`-denied one stays in it as live work.
 */
async function listPendingDiscoveries({ page, pageSize } = {}) {
    const paging = parsePaging({ page, pageSize });
    const activeBotanists = await countActiveBotanists();
    const threshold = effectiveNotAPlantThreshold(activeBotanists);

    const SELECT = `
        SELECT ar.requestId, ar.status, ar.createdAt, ar.note, ar.payload,
               ar.claimedBy, ar.claimedAt, ar.claimSource,
               ar.resolvedBy, ar.resolvedAt,
               ar.recordRequestId, ar.targetPlantId,
               ar.disqualifiedBy, ar.disqualifiedAt, ar.disqualifyReason,
               a.accountId AS reporterId, a.username AS reporterName, rl.roleName AS reporterRole,
               pr.firstName AS reporterFirstName, pr.lastName AS reporterLastName,
               claimer.username AS claimerName,
               cpr.firstName AS claimerFirstName, cpr.lastName AS claimerLastName,
               resolver.username AS resolverName,
disqualifier.username AS disqualifierName,
                -- REQUIRED, not decorative. mapDiscoveryCard computes a LIVE claim
                -- from holder.status plus claimedAt, and without this column the
                -- expression is always false: a claimed report renders with no claim
                -- at all, claimable reads true on it, and the queue offers a Claim
                -- button on work somebody is already doing. The server still refuses
                -- the claim, so nothing is corrupted — but the queue is then lying
                -- about the one thing it exists to coordinate.
                holder.status AS holderStatus,
                (SELECT r.status FROM approval_requests r WHERE r.requestId = ar.recordRequestId) AS recordStatus,
               (SELECT COUNT(*) FROM discovery_votes v WHERE v.requestId = ar.requestId) AS voteCount
        FROM approval_requests ar
        JOIN accounts a ON a.accountId = ar.accountId
        JOIN roles rl ON rl.roleId = a.roleId
        LEFT JOIN profiles pr ON pr.accountId = a.accountId
        LEFT JOIN accounts claimer ON claimer.accountId = ar.claimedBy
        LEFT JOIN profiles cpr ON cpr.accountId = ar.claimedBy
        LEFT JOIN accounts resolver ON resolver.accountId = ar.resolvedBy
        LEFT JOIN accounts disqualifier ON disqualifier.accountId = ar.disqualifiedBy
        LEFT JOIN accounts holder ON holder.accountId = ar.claimedBy`;

    const [rows] = await mysqlPool.query(
        `${SELECT}
         WHERE ar.requestType = ? AND ar.status = 'pending'
         ORDER BY (ar.disqualifiedBy IS NOT NULL) ASC,
                  (ar.resolvedBy IS NOT NULL) ASC,
                  ar.createdAt DESC
         LIMIT ? OFFSET ?`,
        [DISCOVERY_TYPE, paging.pageSize, paging.offset]
    );
    // LEFT JOIN, or an INNER JOIN: an unclaimed report has claimedBy = NULL and no
// matching holder row, so an inner join drops exactly the reports the queue exists
// to show. The result was a card list of N rows against total = 0, which breaks
// every pagination control. `holder` is not referenced by this COUNT at all — it
// was left joined in by habit.
const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total FROM approval_requests ar
         WHERE ar.requestType = ? AND ar.status = 'pending'`,
        [DISCOVERY_TYPE]
    );

    const imagesByRequest = await listDiscoveryImagesForRequests(rows.map((r) => r.requestId));
    const requests = rows.map((r) => mapDiscoveryCard(r, imagesByRequest.get(r.requestId) || [], {
        activeBotanists, threshold
    }));

    return {
        requests,
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize,
        activeBotanists,
        notAPlantThreshold: threshold,
        notAPlantVotes: settings.discoveries.notAPlantVotes
    };
}

/**
 * The one row shape every queue card is built from: the botanist queue, the
 * admin queue and the outcome reads all go through here, so a card cannot show
 * a claim state its own endpoint did not compute.
 */
function mapDiscoveryCard(row, images, options = {}) {
    const payload = parsePayload(row.payload);
    const cutoff = staleClaimCutoff();
    const claimLive = Boolean(row.claimedBy) &&
        row.holderStatus === 'active' &&
        row.claimedAt && new Date(row.claimedAt) > cutoff;
    // A stale claim is not shown as a claim: displaying one nobody holds is
    // exactly the phantom the expiry rule exists to prevent.
    const showClaim = claimLive ? row.claimedBy : null;
    const photosPurged = (row.reviewedAt && row.disqualifiedBy && images.length === 0 &&
        row.reviewedAt < new Date(Date.now() - settings.discoveries.discoveryClosedPhotoDays * 86400000));

    return {
        requestId: row.requestId,
        status: row.status,
        submittedAt: row.createdAt,
        note: payload.note || row.note || null,
        location: payload.location || null,
        predictions: Array.isArray(payload.predictions) ? payload.predictions : [],
        reporterId: row.reporterId,
        reporterName: [row.reporterFirstName, row.reporterLastName].filter(Boolean).join(' ')
            || row.reporterName,
        // Current role of the reporter (superadmin / admin / botanist / user), for the badge.
        reporterRole: row.reporterRole || null,
        images: images.map((img) => ({
            imageId: img.imageId,
            // The BOTANIST queue's route, not the reporter's. The two differ only
            // in their gate — owner match versus record_plant — so a botanist
            // sent here gets a 404 on a photo they are allowed to see.
            url: `/api/discoveries/report-images/${encodeURIComponent(img.imageId)}`,
            mimeType: img.mimeType,
            size: img.size,
            originalFilename: img.originalFilename
        })),
        photosPurged: Boolean(photosPurged),
        claimedBy: showClaim,
        claimedByName: showClaim
            ? ([row.claimerFirstName, row.claimerLastName].filter(Boolean).join(' ') || row.claimerName)
            : null,
        claimedAt: claimLive ? row.claimedAt : null,
        claimAgeDays: claimLive && row.claimedAt
            ? Math.floor((Date.now() - new Date(row.claimedAt).getTime()) / 86400000)
            : null,
        claimSource: claimLive ? row.claimSource : null,
        claimStale: Boolean(row.claimedBy) && !claimLive,
        resolvedBy: row.resolvedBy,
        resolvedAt: row.resolvedAt,
        resolverName: row.resolverName || null,
        recordRequestId: row.recordRequestId,
        recordStatus: row.recordStatus || null,
        targetPlantId: row.targetPlantId || null,
        disqualifiedBy: row.disqualifiedBy,
        disqualifiedAt: row.disqualifiedAt,
        disqualifyReason: row.disqualifyReason || null,
        disqualifierName: row.disqualifierName || null,
        voteCount: Number(row.voteCount || 0),
        notAPlantThreshold: options.threshold ?? null,
        activeBotanists: options.activeBotanists ?? null,
        claimable: !claimLive && row.status === 'pending' &&
            (!row.recordStatus || row.recordStatus !== 'pending')
    };
}

/** the sidebar dot. The DOT counts unclaimed, not pending. */
async function getDiscoveryCounts() {
    const cutoff = staleClaimCutoff();
    const [rows] = await mysqlPool.query(
        `SELECT
            SUM(CASE WHEN ar.status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN ar.status = 'pending'
                      AND NOT ${claimIsLive('holder')}
                      AND (ar.recordRequestId IS NULL
                           OR (SELECT rec.status FROM approval_requests rec WHERE rec.requestId = ar.recordRequestId) <> 'pending')
                     THEN 1 ELSE 0 END) AS unclaimed
         FROM approval_requests ar
         LEFT JOIN accounts holder ON holder.accountId = ar.claimedBy
         WHERE ar.requestType = ?`,
        [cutoff, DISCOVERY_TYPE]
    );
    return {
        pending: Number(rows[0].pending || 0),
        unclaimed: Number(rows[0].unclaimed || 0)
    };
}

/**
 * claim a report.
 *
 * The whole concurrency story is one line: UPDATE ... WHERE the report is still
 * unheld, then check affectedRows. Two botanists racing produce one winner and
 * one clean 409, with no lock table and no FOR UPDATE retry loop.
 *
 * The accounts-row lock is a separate concern from that: it serialises claims BY
 * THE SAME botanist so the cap cannot be raced, while leaving different
 * botanists fully concurrent — the only contention that exists here. Without it
 * two rapid clicks both read a count of 4 and both succeed at 5, which makes the
 * cap advisory and defeats the point of adding it.
 */
async function claimDiscovery(requestId, accountId, { source = 'manual' } = {}) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT ar.requestId, ar.claimedBy, ar.claimedAt, ar.status, ar.recordRequestId,
                    claimer.username AS claimerName, holder.status AS holderStatus
             FROM approval_requests ar
             LEFT JOIN accounts claimer ON claimer.accountId = ar.claimedBy
             LEFT JOIN accounts holder ON holder.accountId = ar.claimedBy
             WHERE ar.requestId = ? AND ar.requestType = ?`,
            [requestId, DISCOVERY_TYPE]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        const report = rows[0];

        // Re-claiming a report you already hold returns the SAME 409 the race
        // produces, and is checked BEFORE the cap: it must not read as "at cap"
        // and must not consume a slot.
        if (report.claimedBy === accountId) {
            await conn.rollback();
            return {
                error: 'You already claimed this report',
                code: 409,
                reason: 'already-claimed-by-you'
            };
        }

        // Get roleId for per-role maxClaimsPerBotanist limit
        const [accountRows] = await conn.query('SELECT roleId FROM accounts WHERE accountId = ? FOR UPDATE', [accountId]);
        const roleId = accountRows[0]?.roleId;

        const activeClaims = await countLiveClaims(conn, accountId);
        // Resolve maxClaimsPerBotanist from role_limits -> system_settings -> settings.js
        let maxClaims;
        if (roleId) {
            const resolved = await resolveLimit(conn, 'maxClaimsPerBotanist', roleId);
            maxClaims = typeof resolved === 'object' ? resolved.maxClaimsPerBotanist : resolved;
        }
        if (!maxClaims) maxClaims = settings.discoveries.maxClaimsPerBotanist;

        if (activeClaims >= maxClaims) {
            await conn.rollback();
            return {
                error: CLAIM_SLOT_RETRY_HINT,
                code: 409,
                activeClaims,
                maxClaims
            };
        }

        // The linked record's status is resolved HERE rather than in a subquery
        // inside the UPDATE: MySQL refuses to read the target table from a
        // subquery in an UPDATE ("You can't specify target table 'ar' for update
        // in FROM clause"), so the whole "submitted is terminal" guard would have
        // to be dropped to keep the subquery.
        const recordStatus = report.recordRequestId
            ? (await conn.query(
                'SELECT status FROM approval_requests WHERE requestId = ?',
                [report.recordRequestId]
            ))[0][0]?.status || null
            : null;

        const SET_CLAIMABLE = `requestId = ? AND requestType = ? AND status = 'pending' AND ? = 1`;

        // Attempt 1: the report is unheld. This one line is the whole concurrency
        // story � two botanists racing produce one winner and one clean 409, with
        // no lock table and no FOR UPDATE retry loop.
        const [fresh] = await conn.query(
            `UPDATE approval_requests
             SET claimedBy = ?, claimedAt = NOW(), claimSource = ?
             WHERE requestId = ? AND requestType = ? AND status = 'pending' AND ? = 1
               AND claimedBy IS NULL`,
            [accountId, source, requestId, DISCOVERY_TYPE, recordStatus !== 'pending' ? 1 : 0]
        );

        let claimed = fresh.affectedRows > 0;

        // Attempt 2: the claim is NOT live. That covers two different situations and
        // both must be takeable, because the card has already told the botanist the
        // report is claimable:
        //
        //   - a DEAD holder. Accounts are suspended, never deleted, so ON DELETE SET
        //     NULL never fires and a suspended botanist's claimedBy would otherwise
        //     stay set forever � nobody else can claim (claimedBy IS NULL) and the
        //     owner cannot act. A claim held by an account that cannot authenticate
        //     is a DEAD claim, not a reservation.
        //   - a STALE holder, older than claimStaleDays. Guarding only on the
        //     holder's status made the card and the server disagree: the card
        //     computes "live" as active AND recent, so it offered Claim, and the
        //     server answered 409 because the holder happened to still be active.
        //     "Live" has to mean the same thing in both places or one of them is
        //     always wrong.
        //
        // Still a conditional UPDATE, and the previous holder is in its WHERE, so
        // two botanists taking the same unheld report still yield one winner.
        const notLive = report.claimedBy && (
            report.holderStatus !== 'active' ||
            !report.claimedAt ||
            new Date(report.claimedAt) <= staleClaimCutoff()
        );
        if (!claimed && notLive) {
            const [takeover] = await conn.query(
                `UPDATE approval_requests
                 SET claimedBy = ?, claimedAt = NOW(), claimSource = ?
                 WHERE ${SET_CLAIMABLE} AND claimedBy = ?`,
                [accountId, source, requestId, DISCOVERY_TYPE,
                    recordStatus !== 'pending' ? 1 : 0, report.claimedBy]
            );
            claimed = takeover.affectedRows > 0;
        }

        if (!claimed) {
            await conn.rollback();
            return { error: await explainUnclaimable(requestId), code: 409 };
        }

        // A claim closes the vote, and it removes only the CLAIMER's own ballot.
        // Clearing the tally would let one person erase a near-unanimous verdict
        // without writing anything; the claimer is simply disqualified from being
        // one of the votes that rejects work they then take up.
        await conn.query(
            'DELETE FROM discovery_votes WHERE requestId = ? AND accountId = ?',
            [requestId, accountId]
        );

        await conn.commit();
        return { requestId, claimedBy: accountId, activeClaims: activeClaims + 1, maxClaims };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}async function explainUnclaimable(requestId) {
    const [rows] = await mysqlPool.query(
        `SELECT ar.status, ar.claimedBy, ar.recordRequestId, ar.claimedAt,
                claimer.username AS claimerName,
                (SELECT rec.status FROM approval_requests rec WHERE rec.requestId = ar.recordRequestId) AS recordStatus
         FROM approval_requests ar
         LEFT JOIN accounts claimer ON claimer.accountId = ar.claimedBy
         WHERE ar.requestId = ?`,
        [requestId]
    );
    if (rows.length === 0) return 'Discovery report not found';
    const r = rows[0];
    if (r.status !== 'pending') {
        return `This report is already ${r.status} and cannot be claimed.`;
    }
    if (r.recordStatus === 'pending') {
        return 'This report already has a record awaiting review.';
    }
    if (r.claimedBy) {
        return `${r.claimerName || 'Another botanist'} claimed this ${formatAge(r.claimedAt)}.`;
    }
    return 'This report cannot be claimed.';
}

function formatAge(timestamp) {
    if (!timestamp) return 'recently';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
    if (seconds < 120) return 'just now';
    if (seconds < 7200) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * releases YOUR OWN claim. Owner-only by default, so two botanists
 * cannot fight over the same report by ping-ponging it.
 *
 * This is the accessibility path the claim cap exists to serve: at the limit,
 * drop one and pick up another.
 */
async function unclaimDiscovery(requestId, accountId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query(
            `UPDATE approval_requests
             SET claimedBy = NULL, claimedAt = NULL, claimSource = 'manual'
             WHERE requestId = ? AND requestType = ? AND claimedBy = ?`,
            [requestId, DISCOVERY_TYPE, accountId]
        );
        if (result.affectedRows === 0) {
            await conn.rollback();
            // 409 rather than 404: the caller may or may not have held it, and
            // "someone else holds it" is the actionable answer.
            return { error: 'You do not hold this claim', code: 409 };
        }
        await conn.commit();
        return { requestId };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 *  the escape hatch for a claim that can never be released normally.
 *
 * Permitted when EITHER the caller holds access_admin, OR the holder is no longer
 * `active`. Accounts are suspended rather than deleted, so ON DELETE SET NULL
 * never fires and a suspended botanist's claimedBy would otherwise stay set
 * forever: nobody else can claim (claimedBy IS NULL) and the owner cannot act.
 * That is the one case where "advisory" stops being advisory — a claim you can
 * see but cannot take. A claim held by an account that cannot authenticate is a
 * DEAD claim, not a reservation.
 */
async function releaseDiscovery(requestId, actorId, actorPermissions) {
    const isAdmin = (actorPermissions || []).includes('access_admin');
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT ar.claimedBy, ar.claimedAt, ar.status, ar.recordRequestId,
                    ar.disqualifiedBy, holder.status AS holderStatus,
                    holder.username AS holderName
             FROM approval_requests ar
             LEFT JOIN accounts holder ON holder.accountId = ar.claimedBy
             WHERE ar.requestId = ? AND ar.requestType = ?`,
            [requestId, DISCOVERY_TYPE]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        const report = rows[0];
        if (!report.claimedBy) {
            await conn.rollback();
            return { error: 'This report has no claim to release', code: 409 };
        }
        if (!isAdmin && report.holderStatus === 'active') {
            // Owner-only stays the default so the ping-pong race is impossible;
            // an admin is the only actor who can take a LIVE claim.
            await conn.rollback();
            return { error: 'Only an admin can release a live claim', code: 403 };
        }

        const previousHolder = report.claimedBy;
        await conn.query(
            `UPDATE approval_requests
             SET claimedBy = NULL, claimedAt = NULL, claimSource = 'manual'
             WHERE requestId = ?`,
            [requestId]
        );
        await conn.commit();

        // After the commit, never inside it: an audit-logging failure must not be
        // able to un-release a claim that was correctly released.
        await logImageReview({
            requestId,
            requestType: DISCOVERY_TYPE,
            imageId: null,
            plantId: null,
            accountId: previousHolder,
            decision: 'claim_released',
            reviewedBy: actorId,
            note: `Released by ${actorId} (previous holder ${previousHolder})`
        });

        return { requestId, previousHolder };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * "I am finished with this". Requires holding the claim, enforced in
 * the WHERE clause, so "resolved" always has an author.
 *
 * Deliberately orthogonal to approval_requests.status: a botanist can close a
 * report while the resulting record still awaits an admin, and if resolvedAt
 * were ever used to gate the queue those two states would disagree — which is
 * normal, not a bug.
 */
async function resolveDiscovery(requestId, accountId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT claimedBy, resolvedBy FROM approval_requests
             WHERE requestId = ? AND requestType = ?`,
            [requestId, DISCOVERY_TYPE]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        if (rows[0].resolvedBy) {
            await conn.rollback();
            return { error: 'This report is already resolved', code: 409 };
        }
        if (rows[0].claimedBy !== accountId) {
            await conn.rollback();
            return { error: 'You must hold the claim to resolve this report', code: 409 };
        }
        await conn.query(
            'UPDATE approval_requests SET resolvedBy = ?, resolvedAt = NOW() WHERE requestId = ?',
            [accountId, requestId]
        );
        await conn.commit();
        return { requestId, resolvedBy: accountId };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * undo your OWN resolution. Deliberately different from
 * reopenDisqualified (any botanist) and from unclaim (owner-only): undoing your
 * own note is a correction.
 */
async function reopenDiscovery(requestId, accountId) {
    const [result] = await mysqlPool.query(
        `UPDATE approval_requests SET resolvedBy = NULL, resolvedAt = NULL
         WHERE requestId = ? AND requestType = ? AND resolvedBy = ?`,
        [requestId, DISCOVERY_TYPE, accountId]
    );
    if (result.affectedRows === 0) {
        return { error: 'Only the botanist who resolved this report can reopen it', code: 409 };
    }
    return { requestId };
}

/**
 * a single botanist's "not a plant" verdict.
 *
 * NOT a status: `status` is admin-owned, `denied` already means an admin
 * rejected the submission, and a botanist may disqualify a report that is already
 * auto-approved — a status transition has nowhere to go from `approved`.
 *
 * Requires holding the claim, so a verdict always has an author. It does NOT
 * set resolvedAt: it is a separate disposition, and conflating them would
 * recreate the ambiguity resolvedBy / recordRequestId exist to prevent.
 *
 * It DOES release the claim, in the same statement. A live claim closes the vote
 * (castNotAPlantVote), so keeping it would make the verdict unfalsifiable: the
 * report stays visible, labelled and contestable to every botanist, and the only
 * person entitled to vote on it is the person who just made it. The queue would
 * then freeze behind the verdict's own author until they released the claim by
 * hand or it went stale — a community judgement that one member has to unlock is
 * not a judgement. Releasing here hands the report straight back to the queue and
 * to the quorum, and the verdict stays reversible by ANY botanist via
 * reinstateDisqualified, which clears both the disqualification and the ballots.
 *
 * One statement, not a claim write followed by a release: the `claimedBy = ?`
 * guard and the clearing have to be the same row version, or a second botanist
 * could claim the report in between and have their claim silently erased.
 */
async function disqualifyDiscovery(requestId, accountId, reason) {
    if (!DISQUALIFY_REASONS.includes(reason)) {
        return {
            error: `reason must be one of: ${DISQUALIFY_REASONS.join(', ')}`,
            code: 400
        };
    }
    const [result] = await mysqlPool.query(
        `UPDATE approval_requests
         SET disqualifiedBy = ?, disqualifiedAt = NOW(), disqualifyReason = ?,
             claimedBy = NULL, claimedAt = NULL, claimSource = 'manual'
         WHERE requestId = ? AND requestType = ? AND claimedBy = ?`,
        [accountId, reason, requestId, DISCOVERY_TYPE, accountId]
    );
    if (result.affectedRows === 0) {
        return { error: 'You must hold the claim to record this verdict', code: 409 };
    }
    await logImageReview({
        requestId,
        requestType: DISCOVERY_TYPE,
        imageId: null,
        plantId: null,
        accountId,
        decision: 'disqualified',
        reviewedBy: accountId,
        note: `${reason} (claim released by the verdict)`
    });
    return { requestId, disqualifiedBy: accountId, disqualifyReason: reason, claimReleased: true };
}

/**
 *  undo a "not a plant".
 *
 * Open to ANY botanist, unlike reopen (author-only). A wrong "not a plant" call
 * hides a real report from everyone, so the remedy must not be gated behind
 * being the person who made the mistake.
 *
 * Clears the vote rows, not just the disqualification: otherwise the same votes
 * would immediately re-fire the moment the report is reopened. A quorum
 * rejection additionally has to reset status from 'rejected' back to 'pending',
 * because that is the only place the quorum wrote a status. A single verdict
 * needs no status change.
 */
async function reinstateDisqualified(requestId, accountId) {
    const conn = await mysqlPool.getConnection();
    const plan = new imageFiles.FileMovePlan();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            'SELECT disqualifiedBy, disqualifiedAt, status FROM approval_requests WHERE requestId = ? AND requestType = ?',
            [requestId, DISCOVERY_TYPE]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        const wasQuorum = rows[0].status === 'rejected';
        if (!rows[0].disqualifiedBy && !wasQuorum) {
            await conn.rollback();
            return { error: 'This report is not marked as not-a-plant', code: 409 };
        }

        await conn.query(
            `UPDATE approval_requests
             SET disqualifiedBy = NULL, disqualifiedAt = NULL, disqualifyReason = NULL
             WHERE requestId = ?`,
            [requestId]
        );
        if (wasQuorum) {
            await conn.query(
                "UPDATE approval_requests SET status = 'pending' WHERE requestId = ? AND status = 'rejected'",
                [requestId]
            );
            // Back to pending: the photos leave the denied folder too.
            await relocation.relocateDiscoveryImages(conn, plan, requestId, 'pending');
        }
        await conn.query('DELETE FROM discovery_votes WHERE requestId = ?', [requestId]);
        await conn.commit();
        await plan.finalize();
        relocation.tidyAfter(plan);

        await logImageReview({
            requestId,
            requestType: DISCOVERY_TYPE,
            imageId: null,
            plantId: null,
            accountId,
            decision: 'disqualification_overridden',
            reviewedBy: accountId,
            note: wasQuorum ? 'Quorum rejection reinstated' : 'Not-a-plant verdict reinstated'
        });

        return { requestId, reinstated: true, wasQuorum };
    } catch (err) {
        await conn.rollback();
        await plan.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function countNotAPlantVotes(requestId) {
    const [rows] = await mysqlPool.query(
        'SELECT COUNT(*) AS n FROM discovery_votes WHERE requestId = ?',
        [requestId]
    );
    return Number(rows[0].n);
}

/**
 * the quorum.
 *
 * A single botanist closing a report disposes of another user's contribution, and
 * the queue is small enough that one wrong call would be unappealable — so the
 * threshold is a community judgement, and a single botanist's verdict
 * (disqualifyDiscovery) stays reinstate-able instead.
 *
 * Insert-or-delete against the composite PK, so a botanist can RETRACT a vote
 * rather than being stuck with it.
 *
 * Below the floor the endpoint refuses rather than storing a ballot that cannot
 * decide anything: a stored-but-inert vote reads as a bug to whoever cast it.
 */
async function castNotAPlantVote(requestId, accountId) {
    const conn = await mysqlPool.getConnection();
    const plan = new imageFiles.FileMovePlan();
    try {
        await conn.beginTransaction();

        const activeBotanists = await countActiveBotanists(conn);
        const threshold = effectiveNotAPlantThreshold(activeBotanists);
        if (activeBotanists < 2) {
            await conn.rollback();
            return {
                error: `Voting needs at least 2 active botanists; there ${activeBotanists === 1 ? 'is' : 'are'} ` +
                    `${activeBotanists}. An admin can close this report instead.`,
                code: 409,
                activeBotanists,
                threshold,
                requiresBotanists: 2
            };
        }

        const [rows] = await conn.query(
            `SELECT ar.requestType, ar.status, ar.recordRequestId, ar.disqualifiedBy,
                    ar.claimedBy, ar.claimedAt, holder.status AS holderStatus,
                    (SELECT rec.status FROM approval_requests rec WHERE rec.requestId = ar.recordRequestId) AS recordStatus
             FROM approval_requests ar
             LEFT JOIN accounts holder ON holder.accountId = ar.claimedBy
             WHERE ar.requestId = ?`,
            [requestId]
        );
        if (rows.length === 0 || rows[0].requestType !== DISCOVERY_TYPE) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        const report = rows[0];

        // OPEN means: pending, no submitted record, and no LIVE claim. Defining it
        // precisely is what stops the rule deadlocking — a botanist who claims and
        // then goes quiet would otherwise block a rejection indefinitely,
        // reintroducing exactly the stranding releaseDiscovery exists to prevent.
        // Once the claim goes stale it stops being live and voting resumes.
        const claimLive = Boolean(report.claimedBy) &&
            report.holderStatus === 'active' &&
            report.claimedAt && new Date(report.claimedAt) > staleClaimCutoff();
        if (report.status !== 'pending' || report.recordRequestId || claimLive) {
            await conn.rollback();
            const why = claimLive
                ? 'This report is claimed; a claim closes the vote.'
                : report.recordRequestId
                    ? 'This report already has a record awaiting review.'
                    : `This report is already ${report.status}.`;
            return { error: why, code: 409, voteCount: await countNotAPlantVotes(requestId) };
        }

        // ONE POST, either action: an existing ballot is RETRACTED, and a botanist
        // with no ballot casts one. So this must ask which of the two it is before
        // writing.
        //
        // Delete-then-insert unconditionally looks equivalent and is not: it always
        // ends with an INSERT, so a second POST from the same botanist re-added the
        // ballot they were trying to withdraw and the tally went back UP. The
        // delete made the double-vote structurally impossible and hid that it had
        // also made retraction impossible.
        const [existing] = await conn.query(
            'SELECT 1 AS present FROM discovery_votes WHERE requestId = ? AND accountId = ?',
            [requestId, accountId]
        );
        const retracting = existing.length > 0;
        if (retracting) {
            await conn.query(
                'DELETE FROM discovery_votes WHERE requestId = ? AND accountId = ?',
                [requestId, accountId]
            );
        } else {
            await conn.query(
                'INSERT INTO discovery_votes (requestId, accountId) VALUES (?, ?)',
                [requestId, accountId]
            );
        }

        const [tallyRows] = await conn.query(
            'SELECT COUNT(*) AS n FROM discovery_votes WHERE requestId = ?',
            [requestId]
        );
        const voteCount = Number(tallyRows[0].n);

        if (voteCount >= threshold) {
            // reviewedBy names the botanist whose vote crossed the threshold, NOT a
            // system account: a quorum is N humans deciding, so attributing it to
            // System would miscredit the community and contradict disqualifiedBy in
            // the same row. discovery_votes is the complete audit and is NOT
            // mirrored into Mongo.
            await conn.query(
                `UPDATE approval_requests
                 SET status = 'rejected',
                     disqualifiedBy = ?, disqualifiedAt = NOW(), disqualifyReason = 'not_a_plant',
                     reviewedBy = ?, reviewedAt = NOW()
                 WHERE requestId = ?`,
                [accountId, accountId, requestId]
            );
            // Rejected by quorum: the report's photos go to the denied folder.
            await relocation.relocateDiscoveryImages(conn, plan, requestId, 'rejected');
        }

        await conn.commit();
        await plan.finalize();
        relocation.tidyAfter(plan);
        return {
            requestId,
            voteCount,
            threshold,
            activeBotanists,
            // Told to the caller rather than inferred: a client cannot tell a
            // retraction from a cast vote from the count alone.
            retracted: retracting,
            rejected: voteCount >= threshold
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
 * the admin audit view. This is the ONLY place voter identities appear
 * — a reporter sees a count, never names.
 *
 * The rows ARE the storage. A reviewedByNames = "acc_000001,acc_000002,…"
 * column would defeat the whole table: the composite PK is what makes
 * double-voting impossible, and collapsing rows into one value removes that,
 * makes "which reports did this botanist vote on?" a LIKE that also matches
 * acc_0000041, breaks retraction, and keeps a deleted account's id forever with
 * no FK to clean it up.
 */
async function listNotAPlantVoters(requestId) {
    const activeBotanists = await countActiveBotanists();
    const threshold = effectiveNotAPlantThreshold(activeBotanists);
    const [rows] = await mysqlPool.query(
        `SELECT v.accountId, a.username, v.votedAt,
                COALESCE(NULLIF(CONCAT(pr.firstName, ' ', pr.lastName), ' '), a.username) AS fullName
         FROM discovery_votes v
         JOIN accounts a ON a.accountId = v.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         WHERE v.requestId = ?
         ORDER BY v.votedAt ASC, v.accountId ASC`,
        [requestId]
    );
    return {
        requestId,
        threshold,
        configured: settings.discoveries.notAPlantVotes,
        activeBotanists,
        voters: rows.map((r) => ({
            accountId: r.accountId,
            username: r.username,
            fullName: r.fullName,
            votedAt: r.votedAt
        }))
    };
}

/**
 * the admin override, which is the only path that closes a report for a
 * team with fewer than two active botanists.
 *
 * Its OWN write, deliberately: disqualifyDiscovery requires holding the
 * claim, enforced in its WHERE, and an admin holds no claim — so routing the
 * override through it would return 409 for every admin, making the one path that
 * makes the threshold survivable for a small team the one path that never works.
 *
 * audited as 'admin_override' so "the community agreed" and "an admin decided
 * alone" stay distinguishable, and so it round-trips through imgreviews at all.
 */
async function adminDisqualifyDiscovery(requestId, adminId, reason) {
    if (!DISQUALIFY_REASONS.includes(reason)) {
        return { error: `reason must be one of: ${DISQUALIFY_REASONS.join(', ')}`, code: 400 };
    }
    const conn = await mysqlPool.getConnection();
    const plan = new imageFiles.FileMovePlan();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            'SELECT status, disqualifiedBy FROM approval_requests WHERE requestId = ? AND requestType = ?',
            [requestId, DISCOVERY_TYPE]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        if (rows[0].status === 'rejected') {
            await conn.rollback();
            return { error: 'This report is already rejected', code: 409 };
        }

        await conn.query(
            `UPDATE approval_requests
             SET status = 'rejected',
                 disqualifiedBy = ?, disqualifiedAt = NOW(), disqualifyReason = ?,
                 reviewedBy = ?, reviewedAt = NOW()
             WHERE requestId = ?`,
            [adminId, reason, adminId, requestId]
        );
        // Clears the vote rows like any other closure, so a reinstated report
        // cannot immediately re-fire the same ballots.
        await conn.query('DELETE FROM discovery_votes WHERE requestId = ?', [requestId]);
        // Closed by an admin: the photos go to the denied folder.
        await relocation.relocateDiscoveryImages(conn, plan, requestId, 'rejected');
        await conn.commit();
        await plan.finalize();
        relocation.tidyAfter(plan);

        await logImageReview({
            requestId,
            requestType: DISCOVERY_TYPE,
            imageId: null,
            plantId: null,
            accountId: rows[0].disqualifiedBy || adminId,
            decision: 'admin_override',
            reviewedBy: adminId,
            note: reason
        });

        return { requestId, status: 'rejected', disqualifiedBy: adminId, disqualifyReason: reason };
    } catch (err) {
        await conn.rollback();
        await plan.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 *  a reporter withdraws their own report.
 *
 * Owner-only, and only while it is still `pending`, no record has been
 * submitted, and it is inside settings.discoveries.cancelGraceHours. Anything
 * else is a 409 with a reason.
 *
 * The row is KEPT, not deleted: it is how an admin spots an account cycling
 * reports, and reviewedBy = the reporter so the audit trail shows who withdrew it.
 * The photos go at once, because the submitter withdrew it and nothing is owed —
 * a denial only defers the same purge to discoveryClosedPhotoDays.
 */
async function cancelDiscoveryReport(requestId, accountId) {
    const conn = await mysqlPool.getConnection();
    let removedFiles = [];
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT ar.status, ar.recordRequestId, ar.claimedBy, ar.createdAt,
                    TIMESTAMPDIFF(MINUTE, ar.createdAt, NOW()) AS minutesOld
             FROM approval_requests ar
             WHERE ar.requestId = ? AND ar.requestType = ? AND ar.accountId = ?`,
            [requestId, DISCOVERY_TYPE, accountId]
        );
        if (rows.length === 0) {
            // 404, never 403: another account must not be able to confirm that
            // someone else's report exists, and neither must an admin.
            await conn.rollback();
            return { error: 'Discovery report not found', code: 404 };
        }
        const report = rows[0];
        if (report.status !== 'pending') {
            await conn.rollback();
            return { error: `This report is already ${report.status} and can no longer be withdrawn.`, code: 409 };
        }
        if (report.recordRequestId) {
            await conn.rollback();
            return { error: 'A botanist already recorded this report, so it can no longer be withdrawn.', code: 409 };
        }
        const grace = settings.discoveries.cancelGraceHours;
        if (Number(report.minutesOld) > grace * 60) {
            await conn.rollback();
            return {
                error: `Reports can only be withdrawn within ${grace} hours of filing.`,
                code: 409
            };
        }

        const [images] = await conn.query(
            'SELECT storedPath FROM discovery_images WHERE requestId = ?',
            [requestId]
        );
        await conn.query('DELETE FROM discovery_images WHERE requestId = ?', [requestId]);
        // A claim is released on cancel, so the botanist's queue card disappears
        // rather than sitting on work that no longer exists.
        await conn.query(
            `UPDATE approval_requests
             SET status = 'cancelled', reviewedBy = ?, reviewedAt = NOW(),
                 claimedBy = NULL, claimedAt = NULL, claimSource = 'manual'
             WHERE requestId = ?`,
            [accountId, requestId]
        );
        await conn.commit();

        removedFiles = images.map((img) => path.join(DISCOVERY_STORAGE_ROOT, img.storedPath));
        for (const destination of removedFiles) {
            try {
                if (fs.existsSync(destination)) fs.unlinkSync(destination);
            } catch (cleanupErr) {
                console.error('Could not remove cancelled report upload:', cleanupErr.message);
            }
        }
        removeEmptyDiscoveryFolders(requestId);

        return { requestId, removedImages: removedFiles.length };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Removes the report's now-empty folder from whichever state folder holds it
 * (pending / approved / denied). The state folders and the discovery root are
 * part of the layout and are never removed.
 */
function removeEmptyDiscoveryFolders(requestId) {
    for (const state of imageFiles.STATES) {
        const stateDir = path.join(DISCOVERY_STORAGE_ROOT, settings.plantImages.statusFolders[state]);
        imageFiles.pruneEmptyDirs(path.join(stateDir, requestId), stateDir);
    }
}

/**
 * the reporter's own view.
 *
 * `state` is a CLOSED SET COMPUTED IN SQL, which is what keeps the internal enum
 * out of the UI and makes the wording changeable without an API change. It must
 * cover every status a report can reach — `not_a_plant` and `cancelled` were
 * missing when this was first written, and it mattered: a quorum-rejected report
 * ALSO has disqualifiedBy set, so two rows would have matched one report and a
 * community rejection would have rendered as "reviewed but not recorded".
 * `status = 'rejected'` therefore takes precedence and is tested FIRST.
 *
 * No claimer's name, no admin note, and voterCount only — never a voter id,
 * username or name. Disclosing the note would leak moderation reasoning to the
 * person being moderated; naming five accounts would leak identities the claim
 * path deliberately withholds.
 */
async function listMyDiscoveryReports(accountId, { page, pageSize } = {}) {
    const paging = parsePaging({ page, pageSize });

    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.status, ar.createdAt, ar.reviewedAt, ar.payload,
                ar.disqualifyReason, ar.targetPlantId,
                ar.disqualifiedBy, ar.recordRequestId,
                p.commonName AS targetCommonName,
                (SELECT COUNT(*) FROM discovery_votes v WHERE v.requestId = ar.requestId) AS voteCount,
                (SELECT di.imageId FROM discovery_images di WHERE di.requestId = ar.requestId
                  ORDER BY di.uploadedAt ASC, di.imageId ASC LIMIT 1) AS photoId
         FROM approval_requests ar
         LEFT JOIN plants p ON p.plantId = ar.targetPlantId
         WHERE ar.accountId = ? AND ar.requestType = ?
         ORDER BY ar.createdAt DESC
         LIMIT ? OFFSET ?`,
        [accountId, DISCOVERY_TYPE, paging.pageSize, paging.offset]
    );
    const [countRows] = await mysqlPool.query(
        'SELECT COUNT(*) AS total FROM approval_requests WHERE accountId = ? AND requestType = ?',
        [accountId, DISCOVERY_TYPE]
    );

    const reports = rows.map((r) => {
        const payload = parsePayload(r.payload);
        const state = discoveryState(r);
        return {
            requestId: r.requestId,
            submittedAt: r.createdAt,
            note: payload.note || null,
            location: payload.location || null,
            photoUrl: r.photoId
                ? `/api/discoveries/images/${encodeURIComponent(r.photoId)}`
                : null,
            state,
            reason: state === 'not_recorded' || state === 'not_a_plant'
                ? r.disqualifyReason || null
                : null,
            voterCount: Number(r.voteCount || 0),
            // ONE hop: targetPlantId is set when the record is approved, so the
            // reporter reaches the plant without resolving recordRequestId.
            plantUrl: state === 'added' && r.targetPlantId
                ? `/plant-profile.html?plantId=${encodeURIComponent(r.targetPlantId)}`
                : null,
            plantName: r.targetCommonName || null
        };
    });

    return {
        reports,
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize
    };
}

/** The seven states of in the order they must be tested. */
function discoveryState(row) {
    if (row.status === 'cancelled') return 'cancelled';
    if (row.status === 'rejected') return 'not_a_plant';
    if (row.status === 'approved') return 'added';
    if (row.status === 'denied') return 'not_added';
    if (row.disqualifiedBy) return 'not_recorded';
    if (row.recordRequestId) return 'recording';
    return 'waiting';
}

/**
 *  tells the report form its numbers BEFORE submission. Convenience only —
 * the server remains the authority, exactly as the client count is in the claim
 * cap.
 */
async function getMyDiscoverySummary(accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT COUNT(*) AS n FROM approval_requests
         WHERE accountId = ? AND requestType = ? AND status = 'pending'`,
        [accountId, DISCOVERY_TYPE]
    );
    const [lastRows] = await mysqlPool.query(
        `SELECT createdAt FROM approval_requests
         WHERE accountId = ? AND requestType = ?
         ORDER BY createdAt DESC LIMIT 1`,
        [accountId, DISCOVERY_TYPE]
    );
    return {
        open: Number(rows[0].n),
        limit: settings.discoveries.maxOpenReportsPerAccount,
        cooldownMinutes: settings.discoveries.reportCooldownMinutes,
        lastFiledAt: lastRows.length > 0 ? lastRows[0].createdAt : null
    };
}

/**
 *  the admin discovery queue, with its OWN mapper.
 *
 * Two mappers rather than one carrying three branches. plantName comes from the
 * top predicted species because a report genuinely has no plant of its own —
 * its targetPlantId is null until its record is approved — and falling back to
 * 'Unidentified plant' keeps the row shape the existing admin assertions expect.
 */
async function listDiscoveryReports({ status, page, pageSize } = {}) {
    const paging = parsePaging({ page, pageSize });
    const cutoff = staleClaimCutoff();
    const activeBotanists = await countActiveBotanists();
    const threshold = effectiveNotAPlantThreshold(activeBotanists);

    const where = ['ar.requestType = ?'];
    const params = [DISCOVERY_TYPE];
    // Defaults to pending, so a rejected report is ONE CLICK away in an audit
    // view. Rejection by committee with no oversight at all is a different
    // feature from "lessen the admin's queue".
    if (status) {
        where.push('ar.status = ?');
        params.push(status);
    } else {
        where.push("ar.status = 'pending'");
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [rows] = await mysqlPool.query(
        `SELECT ar.requestId, ar.status, ar.createdAt, ar.reviewedAt, ar.payload, ar.note,
                ar.claimedBy, ar.claimedAt, ar.claimSource, ar.recordRequestId, ar.targetPlantId,
                ar.disqualifiedBy, ar.disqualifyReason,
                ar.reviewedBy, ar.approvalMode,
                a.accountId AS submitterId, a.username AS submitterName, rl.roleName AS submitterRole,
                pr.firstName AS submitterFirstName, pr.lastName AS submitterLastName,
                claimer.username AS claimerName,
                (SELECT COUNT(*) FROM discovery_votes v WHERE v.requestId = ar.requestId) AS voteCount
         FROM approval_requests ar
         JOIN accounts a ON a.accountId = ar.accountId
         JOIN roles rl ON rl.roleId = a.roleId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         LEFT JOIN accounts claimer ON claimer.accountId = ar.claimedBy
         ${whereSql}
         ORDER BY ar.createdAt ASC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );
    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total FROM approval_requests ar ${whereSql}`,
        params
    );

    const imagesByRequest = await listDiscoveryImagesForRequests(rows.map((r) => r.requestId));

    return {
        requests: rows.map((r) => {
            const payload = parsePayload(r.payload);
            const predictions = Array.isArray(payload.predictions) ? payload.predictions : [];
            const top = predictions[0];
            const fullName = [r.submitterFirstName, r.submitterLastName].filter(Boolean).join(' ');
            return {
                id: r.requestId,
                requestType: DISCOVERY_TYPE,
                plantName: top ? (top.scientificName || top.commonName || 'Unidentified plant') : 'Unidentified plant',
                requestedAt: r.createdAt,
                submittedBy: r.submitterId,
                submittedByName: fullName || r.submitterName,
                submittedByRole: r.submitterRole,
                note: payload.note || r.note || null,
                location: payload.location || null,
                predictions,
                // For a report, "has a description" means the reporter left a note.
                hasDescription: Boolean(payload.note),
                status: r.status,
                images: (imagesByRequest.get(r.requestId) || []).map((img) => ({
                    imageId: img.imageId,
                    url: `/admin/api/discovery-images/${encodeURIComponent(img.imageId)}`
                })),
                claimedBy: r.claimedBy,
                claimedByName: r.claimerName || null,
                claimedAt: r.claimedAt,
                claimSource: r.claimSource,
                recordRequestId: r.recordRequestId,
                targetPlantId: r.targetPlantId,
                disqualifiedBy: r.disqualifiedBy,
                disqualifyReason: r.disqualifyReason,
                // Who closed the report, and whether a human or the rule set did it.
                // A report closed by an automatically approved record carries the
                // SYSTEM account here, which is the point: the trigger was a
                // botanist pressing submit, the decider was the mode.
                reviewedBy: r.reviewedBy,
                approvalMode: r.approvalMode || 'manual',
                voteCount: Number(r.voteCount || 0),
                notAPlantThreshold: threshold,
                activeBotanists
            };
        }),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize,
        activeBotanists,
        notAPlantThreshold: threshold
    };
}

/**
 * the claim rule a botanist's plant submission must satisfy when it
 * carries a discoveryRequestId.
 *
 * The client hides the control behind "view only", but the client is not the
 * authority: without this, ANY botanist could attach a record to a report another
 * botanist is working on.
 *
 * It belongs in the transaction beside the claim validation rather than in
 * middleware: no middleware can know who holds the claim on a payload field.
 */
async function assertDiscoveryClaim(conn, discoveryRequestId, accountId) {
    if (!discoveryRequestId) return null;
    const [rows] = await conn.query(
        `SELECT claimedBy FROM approval_requests WHERE requestId = ? AND requestType = ?`,
        [discoveryRequestId, DISCOVERY_TYPE]
    );
    if (rows.length === 0) {
        return { error: 'Discovery report not found', code: 404 };
    }
    if (rows[0].claimedBy !== accountId) {
        return {
            error: rows[0].claimedBy
                ? 'Another botanist holds this discovery report'
                : 'You must claim this discovery report before recording it',
            code: 409
        };
    }
    return null;
}

/**
 * links the new record to the report that produced it, in the SAME
 * transaction as the insert, so a report can never point at a record that was
 * not created.
 *
 * Also clears the report's votes. Votes answer "is this even a plant?", and a
 * submitted description with measurements is a stronger claim to that question
 * than five opinions — so the veto dissolves against actual work rather than
 * accumulating across attempts. Clearing on SUBMIT is a separate mechanism from
 * the claim and not a replacement for it: dissent can only be dissolved by doing
 * the work, so a revise-denied resubmission starts the tally again at zero.
 */
async function linkDiscoveryRecord(conn, recordRequestId, discoveryRequestId) {
    await conn.query(
        'UPDATE approval_requests SET recordRequestId = ? WHERE requestId = ?',
        [recordRequestId, discoveryRequestId]
    );
    await conn.query('DELETE FROM discovery_votes WHERE requestId = ?', [discoveryRequestId]);
}

/**
 * purge the photos of every CLOSED report whose decision is
 * older than discoveryClosedPhotoDays.
 *
 * The row and its discovery_votes are kept indefinitely — they are the record of
 * what was decided and by whom — and the image is the most intrusive artefact and
 * the least necessary once that is written. `approved` is absent deliberately: an
 * approved report's photos became the plant's own approved images and are not
 * touched here.
 */
async function purgeClosedDiscoveryPhotos() {
    const cutoff = new Date(
        Date.now() - settings.discoveries.discoveryClosedPhotoDays * 24 * 60 * 60 * 1000
    );
    const conn = await mysqlPool.getConnection();
    let purgedRequests = 0;
    let removedFiles = 0;
    try {
        const [rows] = await conn.query(
            `SELECT ar.requestId, di.storedPath
             FROM approval_requests ar
             JOIN discovery_images di ON di.requestId = ar.requestId
             WHERE ar.requestType = ? AND ar.status IN ('denied','rejected')
               AND ar.reviewedAt IS NOT NULL AND ar.reviewedAt < ?`,
            [DISCOVERY_TYPE, cutoff]
        );
        const paths = rows.map((r) => r.storedPath);
        for (const relative of paths) {
            const destination = path.join(DISCOVERY_STORAGE_ROOT, relative);
            try {
                if (fs.existsSync(destination)) {
                    fs.unlinkSync(destination);
                    removedFiles++;
                }
            } catch (err) {
                console.error('Could not remove purged report photo:', err.message);
            }
        }
        const requestIds = [...new Set(rows.map((r) => r.requestId))];
        if (requestIds.length > 0) {
            // The rows go with the files, or the routes would keep handing out URLs
            // for bytes that no longer exist. The report itself survives.
            await conn.query(
                `DELETE FROM discovery_images WHERE requestId IN (${requestIds.map(() => '?').join(',')})`,
                requestIds
            );
            purgedRequests = requestIds.length;
        }
        for (const requestId of requestIds) removeEmptyDiscoveryFolders(requestId);
        return { purgedRequests, removedFiles };
    } finally {
        conn.release();
    }
}

/**
 * real claim expiry, not just an eligibility test.
 *
 * A claim older than claimStaleDays is ACTUALLY released, so a queue card never
 * shows a phantom claim. The predicate deliberately excludes any report that
 * already has a submitted record: an admin's decision outranks a staleness rule,
 * and a record under review is not "stale work" anyone should be handed.
 */
async function expireStaleDiscoveryClaims() {
    const cutoff = staleClaimCutoff();
    const conn = await mysqlPool.getConnection();
    try {
        const [rows] = await conn.query(
            `SELECT requestId, claimedBy FROM approval_requests
             WHERE requestType = ? AND claimedBy IS NOT NULL AND claimedAt IS NOT NULL
               AND claimedAt <= ? AND recordRequestId IS NULL`,
            [DISCOVERY_TYPE, cutoff]
        );
        if (rows.length === 0) return { expired: 0 };
        const [result] = await conn.query(
            `UPDATE approval_requests
             SET claimedBy = NULL, claimedAt = NULL, claimSource = 'manual'
             WHERE requestId IN (${rows.map(() => '?').join(',')})
               AND recordRequestId IS NULL`,
            rows.map((r) => r.requestId)
        );
        for (const row of rows) {
            await logImageReview({
                requestId: row.requestId,
                requestType: DISCOVERY_TYPE,
                imageId: null,
                plantId: null,
                accountId: row.claimedBy,
                decision: 'claim_expired',
                reviewedBy: '',
                note: `Claim older than ${settings.discoveries.claimStaleDays} days`
            });
        }
        return { expired: result.affectedRows };
    } finally {
        conn.release();
    }
}

module.exports = {
    DISQUALIFY_REASONS,
    DISCOVERY_STORAGE_ROOT,
    countActiveBotanists,
    effectiveNotAPlantThreshold,
    getDiscoveryFeatureFlag,
    isAutoDispatchEnabled,
    createDiscoveryReport,
    getDiscoveryImageForOwner,
    getDiscoveryImageForBotanist,
    getDiscoveryImageForReview,
    listPendingDiscoveries,
    getDiscoveryCounts,
    claimDiscovery,
    unclaimDiscovery,
    releaseDiscovery,
    resolveDiscovery,
    reopenDiscovery,
    disqualifyDiscovery,
    reinstateDisqualified,
    countNotAPlantVotes,
    castNotAPlantVote,
    listNotAPlantVoters,
    adminDisqualifyDiscovery,
    cancelDiscoveryReport,
    listMyDiscoveryReports,
    getMyDiscoverySummary,
    listDiscoveryReports,
    assertDiscoveryClaim,
    linkDiscoveryRecord,
    purgeClosedDiscoveryPhotos,
    expireStaleDiscoveryClaims
};
