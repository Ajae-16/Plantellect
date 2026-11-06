// config/scan-contribution.js
//
// Scan contributions, takes the photo a user offers after a very confident scan and files it
// as a PRIVATE, TRAINING-ONLY photo. Called by POST /api/ml/contribute in routes/ml.js.
//
// What a contribution is:
//   status = 'approved' (auto-approved: it is never public, so there is nothing to review)
//   publicVisible = FALSE, isPrimary = FALSE, trainingStatus = 'candidate'
//   origin = 'scan_contribution', contributionConfidence and contributionModelId from the signed offer
//   groupKey = scan:<accountId>:<YYYY-MM-DD>, so one person's photos of one plant on one day always
//   land in the same train / val / test split
//   filed once, as plants/masters/<plantId>/<imageId>.webp, like every other master
//
// OTHER PLANTS: when the model says "Other plant" (a plant it has no class for) and the admin switched
// contributeOtherPlants on, the offer has kind 'other_plant' and no plantId. Such a photo is filed UNASSIGNED:
// plantId NULL, master under plants/masters/<UNASSIGNED_FOLDER>/. A NULL plantId is invisible to every
// plantId-keyed query, so it cannot reach the dataset or the library until an admin moves it to a plant
// (Plants page > Scan contributions > Move). Their daily cap is its own setting (contributeOtherPlantCap), counted as one pool for all users.
//
// What it does NOT do: no thumbnail or display copy, no plant_contributors row, no approval request,
// no review-queue entry. An admin can only archive it ; making it public is refused.
//
// Order of the checks, cheapest and most telling first:
//   1. the signed offer (signature, expiry, this account, these exact bytes)
//   2. the feature is still on for the model, and the offer is still inside the threshold band (lower to upper)
//   3. the photo is not already held (friendly answer)
//   4. the ingest pipeline (type check, upright metadata-free WebP master, hashes)
//   5. one transaction: lock the plant and the account, re-check duplicate, daily cap and species cap,
//      copy the master into place, insert the row, commit
//
// The browser supplies the photo and the token and nothing else. Confidence, plant and model come from
// the token, which only the server can sign. The database and the file tools are injected (`deps`) so
// the rules can be tested without MySQL; with no deps this file loads the real ones.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');
const { verifyOffer, hashImage } = require('./contribute-offer');
const { contributeSettings } = require('./ml-confidence');
const { ingestFiles } = require('./image-ingest');
const imageFiles = require('./image-files');

const GROUP_PREFIX = 'scan';
const UNASSIGNED_FOLDER = '_other_plant';   // master folder of photos that have no plant yet
const SAFE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

class ContributeError extends Error {
    constructor(message, code, reason) {
        super(message);
        this.name = 'ContributeError';
        this.userFacing = true;
        this.code = code;
        this.reason = reason;
    }
}

const fail = (message, code, reason) => ({ error: message, code, reason });

// Token problem -> what the person sees. The browser never learns more than it needs.
const OFFER_FAILURES = {
    malformed: [400, 'invalid_offer', 'This contribution offer is not valid. Scan the plant again.'],
    unsupported_version: [400, 'invalid_offer', 'This contribution offer is not valid. Scan the plant again.'],
    bad_signature: [400, 'invalid_offer', 'This contribution offer is not valid. Scan the plant again.'],
    expired: [410, 'offer_expired', 'This offer has expired. Scan the plant again to contribute the photo.'],
    wrong_account: [403, 'invalid_offer', 'This contribution offer is not valid. Scan the plant again.'],
    wrong_image: [400, 'wrong_image', 'This is not the photo that was scanned. Contribute the same photo you scanned.']
};

// ---------------------------------------------------------------------------
// The "day" the caps and the groupKey use
// ---------------------------------------------------------------------------

/** '+08:00' -> 480 (minutes east of UTC). An unreadable value counts as UTC. */
function offsetMinutes(offset) {
    const match = /^([+-])(\d{1,2}):?(\d{2})$/.exec(String(offset || '').trim());
    if (!match) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === '-' ? -minutes : minutes;
}

/**
 * The calendar day that contains `now`, in the site's timezone (settings.timezone, the same
 * TZ_OFFSET the rest of the site uses). Returns { start, day }: `start` is the Date of local midnight
 * (what the caps count from) and `day` is 'YYYY-MM-DD' (what the groupKey carries).
 */
function dayWindow(now = Date.now(), offset = settings.timezone) {
    const shift = offsetMinutes(offset) * 60 * 1000;
    const localMidnight = Math.floor((now + shift) / 86400000) * 86400000;
    return {
        start: new Date(localMidnight - shift),
        day: new Date(localMidnight).toISOString().slice(0, 10)
    };
}

/** One person's photos for one day share a split. Always under groupKeyMaxLength (100). */
function groupKeyFor(accountId, day) {
    return `${GROUP_PREFIX}:${accountId}:${day}`.slice(0, settings.dataset.groupKeyMaxLength);
}

// ---------------------------------------------------------------------------
// Database pieces
// ---------------------------------------------------------------------------

/** The photo that already holds these upload bytes, as a friendly refusal, or null. */
async function findTakenHash(executor, hash) {
    const [rows] = await executor.query(
        `SELECT imageId, origin FROM plant_images
         WHERE contentHash = ? AND status IN ('pending','approved') LIMIT 1`,
        [hash]
    );
    if (rows.length === 0) return null;
    return rows[0].origin === 'scan_contribution'
        ? fail('This photo has already been contributed. Thank you for helping!', 409, 'already_contributed')
        : fail('This photo is already in the plant library, so it cannot be contributed again.', 409, 'already_in_library');
}

/**
 * For the RECORD flow says why a photo is held when it was first contributed from a scan, so
 * "Record it" after a contribution shows a clear sentence instead of the generic duplicate refusal.
 * Returns the hook image-ingest.js calls (options.describeDuplicate): (hash, name) => { message, reason } | null.
 * null means "not a contribution", and the ingest pipeline keeps its own wording. It reads only.
 */
function describeHeldPhoto(executor) {
    return async function describe(hash, name) {
        const [rows] = await executor.query(
            `SELECT origin FROM plant_images
             WHERE contentHash = ? AND status IN ('pending','approved') LIMIT 1`,
            [hash]
        );
        if (rows.length === 0 || rows[0].origin !== 'scan_contribution') return null;
        return {
            message: `"${name}" was already contributed from a scan to help train the plant model, ` +
                'so it cannot be recorded as well. Choose a different photo.',
            reason: 'already_contributed'
        };
    };
}

async function countSince(executor, column, value, since) {
    // value null = the unassigned (other plant) pool: `= NULL` never matches, so it needs IS NULL.
    const [rows] = value === null
        ? await executor.query(
            `SELECT COUNT(*) AS n FROM plant_images
             WHERE origin = 'scan_contribution' AND \`${column}\` IS NULL AND uploadedAt >= ?`,
            [since]
        )
        : await executor.query(
            `SELECT COUNT(*) AS n FROM plant_images
             WHERE origin = 'scan_contribution' AND \`${column}\` = ? AND uploadedAt >= ?`,
            [value, since]
        );
    return Number(rows[0].n) || 0;
}

// ---------------------------------------------------------------------------
// The contribution
// ---------------------------------------------------------------------------

/**
 * Files one scan photo as a private training photo.
 *
 *   accountId      the session's account
 *   token          the contribute_offer.token from /predict
 *   file           { buffer, originalname, mimetype } the photo as the browser posted it
 *   secret         the signing secret (settings.session.secret)
 *   getMlConfig    async (modelId) => the model's saved mlConfidence entry, or null
 *
 * Returns { ok: true, imageId, plantId } or { error, code, reason }, where `reason` is a short
 * machine word for the UI: invalid_offer, offer_expired, wrong_image, contribute_off, below_threshold, above_threshold,
 * already_contributed, already_in_library, plant_unavailable, daily_cap, species_cap, plus the ingest
 * reasons (type, corrupt, pixels, heic_unavailable, ...). Throws only on a real server fault.
 *
 *   deps.pool / deps.nextKey / deps.ingestOptions / deps.now / deps.tmpDir  (tests only)
 */
async function contributeScanPhoto({ accountId, token, file, secret, getMlConfig }, deps = {}) {
    const now = deps.now ? deps.now() : Date.now();
    if (!accountId) return fail('Sign in to contribute a photo.', 401, 'unauthenticated');
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) return fail('No photo was sent.', 400, 'no_photo');
    if (typeof token !== 'string' || token === '') return fail('No contribution offer was sent.', 400, 'invalid_offer');

    // 1. The signed offer. Account and image hash come from THIS request, never from the token.
    let verified;
    try {
        verified = verifyOffer(token, { secret, accountId, imageSha256: hashImage(file.buffer), now });
    } catch (err) {
        // No signing secret configured: the same state in which /predict makes no offers.
        console.error('Contribute offer could not be checked:', err.message);
        return fail('Photo contributions are not available right now.', 503, 'contribute_unavailable');
    }
    if (!verified.ok) {
        const [code, reason, message] = OFFER_FAILURES[verified.reason] || OFFER_FAILURES.malformed;
        return fail(message, code, reason);
    }
    const offer = verified.offer;

    // 2. Still on, and still above the bar. An admin who switches contributions off (or raises the
    //    threshold) stops offers that are already out, so the setting works as a kill switch.
    const cfg = contributeSettings(await getMlConfig(offer.modelId));
    if (!cfg.on) return fail('Photo contributions are not being accepted right now.', 403, 'contribute_off');
    const otherPlant = offer.kind === 'other_plant';
    // An admin who switches other-plant contributions off stops offers already out, like the main switch.
    if (otherPlant && !cfg.otherPlants) return fail('Photo contributions are not being accepted right now.', 403, 'contribute_off');
    if (!(offer.confidence >= cfg.threshold)) {
        return fail('This photo no longer meets the requirement for contributions.', 403, 'below_threshold');
    }
    if (offer.confidence > cfg.upperThreshold) {
        return fail('This photo no longer meets the requirement for contributions.', 403, 'above_threshold');
    }

    const pool = deps.pool || require('./pool-mysql').mysqlPool;
    const nextKey = deps.nextKey || require('./ids').nextKey;

    // 3. Friendly duplicate answer, before any image work. Repeated inside the transaction below.
    const taken = await findTakenHash(pool, hashImage(file.buffer));
    if (taken) return taken;

    // 4. The normal ingest pipeline. It wants a file on disk, so the bytes are written to the same
    //    landing folder the uploaders use. ingestFiles deletes every temp file itself on a refusal.
    const storageDir = deps.tmpDir || settings.plantImages.storageDir;
    await fsp.mkdir(storageDir, { recursive: true });
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const tempPath = path.join(storageDir, `${crypto.randomUUID()}${SAFE_EXTENSIONS.has(ext) ? ext : ''}`);
    await fsp.writeFile(tempPath, file.buffer, { flag: 'wx' });
    const upload = {
        path: tempPath,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.buffer.length
    };
    const ingested = await ingestFiles([upload], {
        ...(deps.ingestOptions || {}),
        isDuplicate: async (hash) => Boolean(await findTakenHash(pool, hash))
    });
    if (ingested.error) {
        // The same words the record flow uses; a duplicate that slipped past step 3 is named properly.
        if (ingested.reason === 'duplicate') return (await findTakenHash(pool, hashImage(file.buffer))) || fail(ingested.error, ingested.code, 'already_contributed');
        return fail(ingested.error, ingested.code, ingested.reason);
    }

    // 5. One transaction. Locks first, then the checks, so two requests cannot both slip under a cap.
    let conn;
    try {
        conn = await pool.getConnection();
    } catch (err) {
        await fsp.unlink(upload.path).catch(() => {}); // the master temp file must not stay behind
        throw err;
    }
    const plan = new imageFiles.FileMovePlan();
    try {
        await conn.beginTransaction();

        // Lock order is always plant, then account. A plant that is gone or archived cannot take a photo.
        // An other-plant photo has no plant to lock: the account lock below is what keeps its caps exact.
        if (!otherPlant) {
            const [plantRows] = await conn.query(
                'SELECT plantId, archivedAt FROM plants WHERE plantId = ? FOR UPDATE',
                [offer.plantId]
            );
            if (plantRows.length === 0 || plantRows[0].archivedAt) {
                await conn.rollback();
                await plan.rollback();
                return fail('This plant is no longer in the library, so the photo could not be added.', 404, 'plant_unavailable');
            }
        }
        await conn.query('SELECT accountId FROM accounts WHERE accountId = ? FOR UPDATE', [accountId]);

        // The first plain read of the transaction comes after the locks, so it sees every contribution
        // committed before them. That is what makes the duplicate check and both caps exact.
        const raced = await findTakenHash(conn, upload.ingest.contentHash);
        if (raced) {
            await conn.rollback();
            await plan.rollback();
            return raced;
        }

        const { start, day } = dayWindow(now);
        if (await countSince(conn, 'accountId', accountId, start) >= cfg.dailyCap) {
            await conn.rollback();
            await plan.rollback();
            return fail(
                `You have reached today's limit of ${cfg.dailyCap} photo contributions. Thank you for helping. Please try again tomorrow.`,
                429, 'daily_cap'
            );
        }
        if (await countSince(conn, 'plantId', otherPlant ? null : offer.plantId, start) >= (otherPlant ? cfg.otherPlantCap : cfg.speciesCap)) {
            await conn.rollback();
            await plan.rollback();
            return fail(otherPlant
                ? 'We already have enough photos of other plants for today. Thank you for helping!'
                : 'This plant already has enough contributed photos for today. Thank you for helping!', 429, 'species_cap');
        }

        const imageId = await nextKey(conn, 'plant_images');
        const storedFilename = `${imageId}.webp`;
        const relativePath = path.join(imageFiles.plantMasterRelativeDir(otherPlant ? UNASSIGNED_FOLDER : offer.plantId), storedFilename);
        const copied = await plan.stage(upload.path, path.join(settings.plantImages.storageDir, relativePath), { mimeType: 'image/webp' });
        if (!copied.ok) {
            throw new ContributeError(
                `The photo could not be saved cleanly after ${copied.attempts || 1} attempts (${copied.error}). Please try again.`,
                500, 'save_failed'
            );
        }

        await conn.query(
            `INSERT INTO plant_images
                (imageId, plantId, accountId, originalFilename, storedFilename, storedPath, mimeType, size,
                 status, isPrimary, reviewedAt, contentHash, perceptualHash, groupKey, trainingStatus,
                 publicVisible, origin, contributionConfidence, contributionModelId)
             VALUES (?, ?, ?, ?, ?, ?, 'image/webp', ?,
                 'approved', FALSE, CURRENT_TIMESTAMP, ?, ?, ?, 'candidate',
                 FALSE, 'scan_contribution', ?, ?)`,
            [
                imageId, otherPlant ? null : offer.plantId, accountId, String(file.originalname || 'scan.webp').slice(0, 255), storedFilename,
                relativePath, upload.size, upload.ingest.contentHash, upload.ingest.perceptualHash,
                groupKeyFor(accountId, day), Number(offer.confidence).toFixed(4), String(offer.modelId).slice(0, 64)
            ]
        );

        await conn.commit();
        await plan.finalize(); // the temp master is deleted only now that the row points at the copy
        return { ok: true, imageId, plantId: otherPlant ? null : offer.plantId, kind: otherPlant ? 'other_plant' : 'species' };
    } catch (err) {
        await conn.rollback().catch(() => {});
        await plan.rollback();
        if (err && err.userFacing) return fail(err.message, err.code, err.reason);
        throw err;
    } finally {
        conn.release();
        // Whatever happened, the temp master does not stay behind (after finalize() it is already gone).
        await fsp.unlink(upload.path).catch(() => {});
    }
}

module.exports = { UNASSIGNED_FOLDER, contributeScanPhoto, describeHeldPhoto, dayWindow, groupKeyFor, offsetMinutes, OFFER_FAILURES };
