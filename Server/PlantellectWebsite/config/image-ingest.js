// The upload pipeline (dataset handler plan, stage 5).
//
// Runs on every photo upload, after multer has applied its size and count limits
// and BEFORE anything is written to the database:
//
//   1. Type check. file-type reads the real bytes. The result must agree with the
//      file extension and with the declared type, and must be JPEG, PNG, WebP or
//      HEIC/HEIF. No SVG, no GIF, nothing else.
//   2. HEIC (iPhone) is sent to the ML service, which returns an upright JPEG
//      with no metadata. If that service is down the HEIC upload fails with a
//      clear message; every other format keeps working.
//   3. sharp opens the image (a corrupt file is refused here, and a pixel limit
//      stops decompression bombs), turns it upright using the orientation flag,
//      and re-encodes it to the master WebP. Everything else in the file's
//      metadata is dropped WITHOUT being read.
//   4. Hashing: SHA-256 of the bytes the person uploaded, and a 64-bit dHash of the
//      master. A SHA-256 already held by a pending or approved photo is refused.
//
// PRIVACY RULE: this code never reads GPS, capture time or any other photo
// metadata, and stores none. The only metadata ever used is the orientation flag,
// and only so the picture can be turned upright. sharp's .metadata() is not called.
//
// What it hands back is the SAME file object multer made, rewritten to describe the
// master: path (a temporary master file), mimetype image/webp, size, and an
// `ingest` block with the hashes. The raw upload is deleted. The caller moves the
// master into its final place (stageImages in record-mysql.js, createDiscoveryReport
// in discovery-mysql.js).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');

class IngestError extends Error {
    constructor(message, code = 400, reason = 'rejected') {
        super(message);
        this.name = 'IngestError';
        this.userFacing = true;
        this.code = code;
        this.reason = reason;
    }
}

const LABELS = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', heic: 'HEIC' };
const ALLOWED_LIST = 'JPEG, PNG, WebP or HEIC';

const EXTENSION_KINDS = {
    '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.heic': 'heic', '.heif': 'heic'
};
const MIME_KINDS = {
    'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heic', 'image/heic-sequence': 'heic', 'image/heif-sequence': 'heic'
};
// What file-type may answer, mapped to our kinds. Anything else is "not allowed".
const DETECTED_KINDS = MIME_KINDS;

const shortName = (name) => String(name || 'photo').replace(/[\r\n]+/g, ' ').slice(0, 80);

// ---------------------------------------------------------------------------
// 1. Type check
// ---------------------------------------------------------------------------

/**
 * The real type of the bytes, as a mime string, or null.
 * file-type 22 is ESM-only; on Node 22.12+ / 24 a plain require() of it works.
 */
let fileTypeModule = null;
async function defaultDetect(buffer) {
    if (!fileTypeModule) fileTypeModule = require('file-type');
    const found = await fileTypeModule.fileTypeFromBuffer(buffer);
    return found ? found.mime : null;
}

/**
 * Returns the kind ('jpeg' | 'png' | 'webp' | 'heic') when the bytes, the extension
 * and the declared type all agree, else throws an IngestError the person can act on.
 */
async function checkType({ buffer, originalname, mimetype }, detect = defaultDetect) {
    const name = shortName(originalname);
    const ext = path.extname(String(originalname || '')).toLowerCase();
    const extKind = EXTENSION_KINDS[ext] || null;

    const detectedMime = await detect(buffer);
    const detectedKind = detectedMime ? (DETECTED_KINDS[detectedMime] || null) : null;
    if (!detectedKind) {
        throw new IngestError(
            `"${name}" is not a photo this site can read. Use a ${ALLOWED_LIST} photo.`, 400, 'type'
        );
    }
    if (!extKind || extKind !== detectedKind) {
        throw new IngestError(
            `"${name}" is a ${LABELS[detectedKind]} photo but its name ends in "${ext || 'nothing'}". ` +
            'Rename it correctly or export it again, then upload it.', 400, 'type'
        );
    }

    const declared = String(mimetype || '').toLowerCase().split(';')[0].trim();
    const declaredKind = MIME_KINDS[declared] || null;
    const generic = declared === '' || declared === 'application/octet-stream';
    // A generic declared type is only accepted for HEIC, where browsers really do send it.
    const declaredOk = declaredKind === detectedKind || (generic && detectedKind === 'heic');
    if (!declaredOk) {
        throw new IngestError(
            `"${name}" says it is "${declared || 'unknown'}" but it is really a ${LABELS[detectedKind]} photo. ` +
            'Export it again and upload the new file.', 400, 'type'
        );
    }
    return detectedKind;
}

// ---------------------------------------------------------------------------
// 2. HEIC -> upright JPEG, through the ML service
// ---------------------------------------------------------------------------

const HEIC_DOWN =
    'HEIC photos cannot be converted right now. Please try again in a few minutes, ' +
    'or upload a JPEG or PNG version of the photo.';

async function heicToJpeg(buffer, name, {
    fetchImpl = globalThis.fetch,
    serviceUrl = settings.ml.serviceUrl,
    timeoutMs = settings.ingest.heicTimeoutMs
} = {}) {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: 'image/heic' }), 'photo.heic');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status;
    let body;
    try {
        const response = await fetchImpl(`${serviceUrl}/convert/heic`, {
            method: 'POST', body: form, signal: controller.signal
        });
        status = response.status;
        body = Buffer.from(await response.arrayBuffer());
    } catch (err) {
        // Service stopped, refused the connection, or did not answer in time.
        throw new IngestError(HEIC_DOWN, 503, 'heic_unavailable');
    } finally {
        clearTimeout(timer);
    }

    if (status === 200) {
        // A JPEG, or something is wrong with the service.
        if (body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return body;
        throw new IngestError(HEIC_DOWN, 503, 'heic_unavailable');
    }
    if (status === 400 || status === 413 || status === 415 || status === 422) {
        throw new IngestError(
            `"${name}" could not be read as a HEIC photo (damaged, too large, or not a photo). ` +
            'Try exporting it again as a JPEG.', 400, 'heic_rejected'
        );
    }
    throw new IngestError(HEIC_DOWN, 503, 'heic_unavailable');
}

// ---------------------------------------------------------------------------
// 3. The master WebP
// ---------------------------------------------------------------------------

/**
 * sharp is required lazily so a module that only needs the error type or the type
 * check does not load libvips.
 *
 * .rotate() with no argument turns the picture upright using the orientation flag,
 * which is the only metadata read. The output carries no metadata because nothing
 * asks sharp to keep any. Only the first frame is decoded (animated: false).
 * failOn 'warning' makes a cut-off or damaged file fail here instead of becoming a
 * half-grey training image. A transparent PNG is flattened onto white, so the
 * master is always plain RGB.
 */
async function buildMaster(buffer, name, options = {}) {
    const sharp = require('sharp');
    const longEdge = options.masterLongEdge || settings.ingest.masterLongEdge;
    const quality = options.masterQuality || settings.ingest.masterQuality;
    const limitInputPixels = options.maxInputPixels || settings.ingest.maxInputPixels;
    try {
        const { data, info } = await sharp(buffer, { limitInputPixels, failOn: 'warning', animated: false })
            .rotate()
            .flatten({ background: '#ffffff' })
            .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
            .webp({ quality, effort: 4 })
            .toBuffer({ resolveWithObject: true });
        return { buffer: data, width: info.width, height: info.height };
    } catch (err) {
        if (/pixel limit/i.test(err.message)) {
            throw new IngestError(
                `"${name}" has too many pixels (the limit is ${Math.round(limitInputPixels / 1e6)} million). ` +
                'Use a smaller photo.', 413, 'pixels'
            );
        }
        throw new IngestError(
            `"${name}" could not be read. The file may be damaged or cut short. Take or export the photo again.`,
            400, 'corrupt'
        );
    }
}

// ---------------------------------------------------------------------------
// 4. Hashes
// ---------------------------------------------------------------------------

const sha256Hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * 64-bit difference hash, 16 hex characters, with the same recipe as
 * ml/app/dataset_tools/fingerprint.py: greyscale, 9x8, bit = pixel is brighter than
 * its left neighbour, first bit is the most significant. Two different libraries
 * resample slightly differently, so compare hashes by Hamming distance and never by
 * equality. It is read from the master, which is already upright and metadata-free.
 */
async function perceptualHash(masterBuffer) {
    const sharp = require('sharp');
    const { data, info } = await sharp(masterBuffer)
        .removeAlpha()
        .toColourspace('b-w')
        .resize(9, 8, { fit: 'fill', kernel: 'lanczos3' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const step = info.channels;
    let value = 0n;
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const left = data[(row * 9 + col) * step];
            const right = data[(row * 9 + col + 1) * step];
            value = (value << 1n) | (right > left ? 1n : 0n);
        }
    }
    return value.toString(16).padStart(16, '0');
}

/**
 * True when a PENDING or APPROVED photo already has these exact upload bytes. A denied
 * photo does not count, so a botanist can upload a corrected attempt again. With
 * includeDiscoveries, a photo in a still-pending discovery report counts too.
 * `executor` is a mysql2 pool or connection, injected so this file never loads the
 * database layer.
 */
async function hashIsTaken(executor, hash, { includeDiscoveries = false } = {}) {
    const [plantRows] = await executor.query(
        `SELECT imageId FROM plant_images
         WHERE contentHash = ? AND status IN ('pending','approved') LIMIT 1`,
        [hash]
    );
    if (plantRows.length > 0) return true;
    if (!includeDiscoveries) return false;
    const [discoveryRows] = await executor.query(
        `SELECT di.imageId FROM discovery_images di
         JOIN approval_requests ar ON ar.requestId = di.requestId
         WHERE di.contentHash = ? AND ar.status = 'pending' LIMIT 1`,
        [hash]
    );
    return discoveryRows.length > 0;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

async function removeQuietly(file) {
    if (file) await fsp.unlink(file).catch(() => {});
}

/**
 * Processes ONE multer file in place. Returns the file object, now describing the
 * master. Throws IngestError for anything the person can fix.
 *
 *   options.detect          type detector (tests only)
 *   options.fetchImpl       fetch (tests only)
 *   options.isDuplicate     async (hash) => boolean
 *   options.seenHashes      Set, shared across one request, to catch the same photo twice
 */
async function ingestFile(file, options = {}) {
    const name = shortName(file.originalname);
    const uploadPath = file.path;
    let masterPath = null;
    try {
        const original = await fsp.readFile(uploadPath);
        if (original.length === 0) {
            throw new IngestError(`"${name}" is empty.`, 400, 'corrupt');
        }

        const kind = await checkType({ buffer: original, originalname: file.originalname, mimetype: file.mimetype }, options.detect);

        // Hash the upload itself: re-encoding changes the bytes, so the master cannot be hashed for this.
        const contentHash = sha256Hex(original);
        if (options.seenHashes) {
            if (options.seenHashes.has(contentHash)) {
                throw new IngestError(`"${name}" was selected twice. Keep one copy of the photo.`, 409, 'duplicate');
            }
        }
        if (options.isDuplicate && await options.isDuplicate(contentHash)) {
            throw new IngestError(
                `"${name}" has already been submitted. Choose a different photo.`, 409, 'duplicate'
            );
        }

        const decodable = kind === 'heic'
            ? await heicToJpeg(original, name, { fetchImpl: options.fetchImpl, serviceUrl: options.serviceUrl, timeoutMs: options.heicTimeoutMs })
            : original;

        const master = await buildMaster(decodable, name, options);
        const dhash = await perceptualHash(master.buffer);

        masterPath = path.join(path.dirname(uploadPath), `${crypto.randomUUID()}.master.webp`);
        await fsp.writeFile(masterPath, master.buffer, { flag: 'wx' });

        if (options.seenHashes) options.seenHashes.add(contentHash);

        // The raw upload is not kept.
        await removeQuietly(uploadPath);

        file.ingest = {
            contentHash,
            perceptualHash: dhash,
            width: master.width,
            height: master.height,
            sourceKind: kind,
            sourceSize: file.size
        };
        file.path = masterPath;
        file.filename = path.basename(masterPath);
        file.mimetype = 'image/webp';
        file.size = master.buffer.length;
        return file;
    } catch (err) {
        await removeQuietly(masterPath);
        throw err;
    }
}

/**
 * Processes every file of one request. All or nothing: on the first problem every
 * temporary file (raw or master) is deleted and { error, code } comes back, so a
 * submission never half-lands.
 */
async function ingestFiles(files, options = {}) {
    const list = Array.isArray(files) ? files : [];
    const seenHashes = options.seenHashes || new Set();
    try {
        for (const file of list) {
            await ingestFile(file, { ...options, seenHashes });
        }
        return { ok: true };
    } catch (err) {
        for (const file of list) await removeQuietly(file.path);
        if (err instanceof IngestError) return { error: err.message, code: err.code, reason: err.reason };
        throw err;
    }
}

/**
 * Express middleware. Put it right after the multer middleware:
 *   router.post('/requests', ..., plantImageUpload(getLimits), ingestUploads({ executor: mysqlPool }), handler)
 * With no files it does nothing, so a route that also takes a JSON body is unaffected.
 */
function ingestUploads({ executor, includeDiscoveries = false, options = {} } = {}) {
    return async function ingestMiddleware(req, res, next) {
        const files = req.files || (req.file ? [req.file] : []);
        if (!Array.isArray(files) || files.length === 0) return next();
        try {
            const result = await ingestFiles(files, {
                ...options,
                isDuplicate: executor ? (hash) => hashIsTaken(executor, hash, { includeDiscoveries }) : undefined
            });
            if (result.error) return res.status(result.code).json({ error: result.error });
            return next();
        } catch (err) {
            for (const file of files) await removeQuietly(file.path);
            return next(err);
        }
    };
}

module.exports = {
    IngestError,
    checkType,
    heicToJpeg,
    buildMaster,
    perceptualHash,
    sha256Hex,
    hashIsTaken,
    ingestFile,
    ingestFiles,
    ingestUploads
};
