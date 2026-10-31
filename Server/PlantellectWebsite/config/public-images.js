// Public copies of approved photos (dataset handler plan, stage 6).
//
// Every approved, visible photo has two small WebP copies that the public site shows:
//
//   public/resource/plant-images/thumbnail/<plantId>/<imageId>.webp   (cards, lists)
//   public/resource/plant-images/display/<plantId>/<imageId>.webp     (plant page, zoom)
//
// The MASTER stays where it is and is never served to the public. A public copy is
// always generated FROM a master, never from user input:
//
//   - the file name is built from validated ids (letters, digits, "_" and "-" only);
//   - it is written to a temporary file in the same folder and renamed into place, so
//     a reader never sees half a file;
//   - the output carries no metadata, because nothing asks sharp to keep any (and
//     this code never reads any: sharp's .metadata() is not called);
//   - the SHA-256 of each copy is stored on the plant_images row (thumbnailHash,
//     displayHash). A row with no hash has no public copy, and public queries only
//     list photos that have both, so a failed copy shows as "no photo", never as a
//     broken link.
//
// Public copies are served statically by publicImageHandler() below (mounted in
// index.js BEFORE the general static handler): no database lookup per image, WebP
// only, nosniff, no directory listing, and a short cache taken from
// settings.plantImages.publicCacheSeconds. A photo with no file there answers 404.
//
// Stage 7a adds hide / restore (config/photo-visibility.js) and removal on denial on top
// of these primitives; stage 7b adds the reconcile job.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');

const SIZES = ['thumbnail', 'display'];
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_PATH = /^\/(thumbnail|display)\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\.webp$/;

const root = () => path.resolve(settings.plantImages.publicDir);

function assertSafeIds(plantId, imageId) {
    if (!SAFE_ID.test(String(plantId || '')) || !SAFE_ID.test(String(imageId || ''))) {
        throw new Error('A public image path needs a plantId and an imageId made of letters, digits, "_" and "-"');
    }
}

/** Absolute path of one public copy. Throws on an unsafe id or an unknown size. */
function publicFilePath(size, plantId, imageId) {
    if (!SIZES.includes(size)) throw new Error(`Unknown public image size "${size}"`);
    assertSafeIds(plantId, imageId);
    const file = path.resolve(root(), size, String(plantId), `${imageId}.webp`);
    if (!file.startsWith(root() + path.sep)) throw new Error('Public image path escapes its folder');
    return file;
}

/** URL of one public copy, as the browser and the Android app use it. */
function publicUrl(size, plantId, imageId) {
    if (!SIZES.includes(size)) throw new Error(`Unknown public image size "${size}"`);
    assertSafeIds(plantId, imageId);
    return `${settings.plantImages.publicUrlBase}/${size}/${plantId}/${imageId}.webp`;
}

/** { imageUrl (display), thumbnailUrl } for a photo, or both null when there is none. */
function publicUrls(plantId, imageId) {
    if (!plantId || !imageId) return { imageUrl: null, thumbnailUrl: null };
    return {
        imageUrl: publicUrl('display', plantId, imageId),
        thumbnailUrl: publicUrl('thumbnail', plantId, imageId)
    };
}

/**
 * SQL for "this photo may be shown to the public", for an alias of plant_images.
 * A photo needs both copies' hashes, so a copy that failed to generate is simply
 * not listed. Plant-level archiving is filtered separately by the plant queries.
 */
function visibleImageSql(alias = 'i') {
    return `${alias}.status = 'approved' AND ${alias}.publicVisible = TRUE AND ${alias}.archivedAt IS NULL ` +
        `AND ${alias}.thumbnailHash IS NOT NULL AND ${alias}.displayHash IS NOT NULL`;
}

// ---------------------------------------------------------------------------
// Rendering and writing
// ---------------------------------------------------------------------------

const sha256Hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Re-encodes a master into one public size. .rotate() with no argument only applies
 * the orientation flag (masters are already upright, so this is a no-op for them);
 * no metadata is written. A copy is never larger than its master.
 */
async function renderCopy(masterBuffer, size, options = {}) {
    const sharp = require('sharp');
    const longEdge = size === 'thumbnail'
        ? (options.thumbnailLongEdge || settings.plantImages.thumbnailLongEdge)
        : (options.displayLongEdge || settings.plantImages.displayLongEdge);
    const quality = options.quality || settings.plantImages.publicCopyQuality;
    return sharp(masterBuffer, { limitInputPixels: settings.ingest.maxInputPixels, failOn: 'warning', animated: false })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();
}

/** Writes to a temporary file in the same folder, then renames it into place. */
async function writeAtomic(file, buffer) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = path.join(path.dirname(file), `.${crypto.randomUUID()}.tmp`);
    try {
        await fsp.writeFile(temp, buffer, { flag: 'wx' });
        await fsp.rename(temp, file);
    } catch (err) {
        await fsp.unlink(temp).catch(() => {});
        throw err;
    }
}

/** The master file of a plant_images row, or null when its path escapes the image root. */
function masterFileOf(storedPath) {
    const base = path.resolve(settings.plantImages.storageDir);
    const file = path.resolve(base, String(storedPath || ''));
    return file.startsWith(base + path.sep) ? file : null;
}

/**
 * Generates both public copies of one photo from its master and returns their hashes.
 * Does not touch the database. `row` needs { imageId, plantId, storedPath }.
 * Returns { ok: true, thumbnailHash, displayHash } or { ok: false, error }.
 */
async function buildPublicCopies(row, options = {}) {
    try {
        if (!row || !row.plantId) return { ok: false, error: 'the photo has no plant to file it under' };
        const masterFile = masterFileOf(row.storedPath);
        if (!masterFile) return { ok: false, error: 'the master path is outside the image folder' };
        const master = await fsp.readFile(masterFile).catch(() => null);
        if (!master) return { ok: false, error: 'the master file is missing' };

        const out = {};
        for (const size of SIZES) {
            const buffer = await renderCopy(master, size, options);
            await writeAtomic(publicFilePath(size, row.plantId, row.imageId), buffer);
            out[`${size}Hash`] = sha256Hex(buffer);
        }
        return { ok: true, ...out };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/** Deletes both public copies of one photo. A copy that is already gone is fine. */
async function removePublicCopies(plantId, imageId) {
    for (const size of SIZES) {
        const file = publicFilePath(size, plantId, imageId);
        try {
            await fsp.unlink(file);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        await fsp.rmdir(path.dirname(file)).catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Database side
// ---------------------------------------------------------------------------

const defaultExecutor = () => require('./pool-mysql').mysqlPool;

async function storeHashes(executor, imageId, built) {
    await executor.query(
        'UPDATE plant_images SET thumbnailHash = ?, displayHash = ? WHERE imageId = ?',
        [built.thumbnailHash, built.displayHash, imageId]
    );
}

/**
 * Creates the public copies for the given photos. Call it AFTER the approval has
 * committed and the photo files have been moved, so storedPath is final. Only a photo
 * that is approved, visible, unarchived and tied to a plant gets copies.
 *
 * Never throws: an approval is a decision about content and must not fail because an
 * image could not be re-encoded. A photo that fails has no hash, so it is not listed
 * publicly, and fillMissingPublicCopies() retries it at the next start.
 * Returns { made, failed: [{ imageId, message }] }.
 */
async function ensurePublicCopies(imageIds, { executor, options } = {}) {
    const result = { made: 0, failed: [] };
    const ids = [...new Set((imageIds || []).filter(Boolean))];
    if (ids.length === 0) return result;
    try {
        const db = executor || defaultExecutor();
        const [rows] = await db.query(
            `SELECT imageId, plantId, storedPath FROM plant_images
             WHERE imageId IN (${ids.map(() => '?').join(',')})
               AND status = 'approved' AND publicVisible = TRUE AND archivedAt IS NULL AND plantId IS NOT NULL`,
            ids
        );
        for (const row of rows) {
            const built = await buildPublicCopies(row, options);
            if (built.ok) {
                await storeHashes(db, row.imageId, built);
                result.made++;
            } else {
                result.failed.push({ imageId: row.imageId, message: built.error });
                console.error(`Public copies for ${row.imageId} could not be made: ${built.error}`);
            }
        }
    } catch (err) {
        console.error('Public copy generation failed:', err.message);
        result.failed.push({ imageId: null, message: err.message });
    }
    return result;
}

/**
 * Takes the public copies of the given photos down and clears their hashes. Used when a
 * photo is denied or withdrawn: a pending photo never had copies, so for the normal
 * case this finds nothing to do, but a photo that somehow has them must lose them the
 * moment it stops being approved.
 *
 * Runs AFTER the decision has committed and never throws: a failed delete is logged
 * and the reconcile job (stage 7b) removes any file that no longer has a visible
 * record. Returns { removed, failed }.
 */
async function removeCopiesForImages(imageIds, { executor } = {}) {
    const result = { removed: 0, failed: 0 };
    const ids = [...new Set((imageIds || []).filter(Boolean))];
    if (ids.length === 0) return result;
    try {
        const db = executor || defaultExecutor();
        const [rows] = await db.query(
            `SELECT imageId, plantId FROM plant_images
             WHERE imageId IN (${ids.map(() => '?').join(',')}) AND plantId IS NOT NULL`,
            ids
        );
        for (const row of rows) {
            try {
                await removePublicCopies(row.plantId, row.imageId);
                await db.query(
                    'UPDATE plant_images SET thumbnailHash = NULL, displayHash = NULL WHERE imageId = ?',
                    [row.imageId]
                );
                result.removed++;
            } catch (err) {
                result.failed++;
                console.error(`Public copies for ${row.imageId} could not be removed: ${err.message}`);
            }
        }
    } catch (err) {
        console.error('Public copy removal failed:', err.message);
        result.failed++;
    }
    return result;
}

/**
 * Startup catch-up: generates copies for every approved, visible photo that has none
 * (no hash, or a file that is missing). It only ADDS; it never deletes or compares
 * hashes. Stage 7's reconcile job extends this with orphan removal and tamper repair.
 */
async function fillMissingPublicCopies({ executor, options } = {}) {
    const summary = { checked: 0, made: 0, failed: 0 };
    try {
        const db = executor || defaultExecutor();
        const [rows] = await db.query(
            `SELECT imageId, plantId, storedPath, thumbnailHash, displayHash FROM plant_images
             WHERE status = 'approved' AND publicVisible = TRUE AND archivedAt IS NULL AND plantId IS NOT NULL`
        );
        for (const row of rows) {
            summary.checked++;
            const present = row.thumbnailHash && row.displayHash
                && fs.existsSync(publicFilePath('thumbnail', row.plantId, row.imageId))
                && fs.existsSync(publicFilePath('display', row.plantId, row.imageId));
            if (present) continue;
            const built = await buildPublicCopies(row, options);
            if (built.ok) {
                await storeHashes(db, row.imageId, built);
                summary.made++;
            } else {
                summary.failed++;
                console.error(`Public copies for ${row.imageId} could not be made: ${built.error}`);
            }
        }
    } catch (err) {
        console.error('Public copy catch-up failed:', err.message);
    }
    return summary;
}

// ---------------------------------------------------------------------------
// The static handler
// ---------------------------------------------------------------------------

/** Maps a request path (relative to the mount) to a file, or null when it is not a public copy path. */
function resolveRequestPath(requestPath) {
    const match = REQUEST_PATH.exec(String(requestPath || ''));
    if (!match) return null;
    try {
        return publicFilePath(match[1], match[2], match[3]);
    } catch (err) {
        return null;
    }
}

function cacheControl() {
    const seconds = settings.plantImages.publicCacheSeconds;
    return seconds > 0 ? `public, max-age=${seconds}, must-revalidate` : 'no-cache';
}

/**
 * Express middleware for /resource/plant-images. Its own handler on purpose: it
 * answers EVERYTHING under that prefix and never calls next(), so the general static
 * handler can never serve a stray file from this folder (a temporary file, a leftover,
 * something dropped in by hand). Only the exact path shape of a generated copy is
 * served, so there is no listing, no index file and no traversal to defend against.
 */
function publicImageHandler() {
    return function servePublicImage(req, res) {
        const notFound = () => res.status(404).type('text/plain').send('Not found');
        if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
        const file = resolveRequestPath(req.path);
        if (!file) return notFound();
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', cacheControl());
        return res.sendFile(file, { dotfiles: 'deny', acceptRanges: false }, (err) => {
            if (err && !res.headersSent) {
                res.removeHeader('Cache-Control');
                notFound();
            }
        });
    };
}

function ensurePublicTree() {
    for (const size of SIZES) fs.mkdirSync(path.join(root(), size), { recursive: true });
}

module.exports = {
    SIZES,
    publicFilePath,
    masterFileOf,
    publicUrl,
    publicUrls,
    visibleImageSql,
    renderCopy,
    buildPublicCopies,
    removePublicCopies,
    ensurePublicCopies,
    removeCopiesForImages,
    fillMissingPublicCopies,
    resolveRequestPath,
    publicImageHandler,
    ensurePublicTree
};
