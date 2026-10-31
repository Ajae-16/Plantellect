// Image file handling: folder layout, verified copy, and the move plan.
//
// The rule for every photo that changes folder:
//
//   1. COPY it to the new folder (never rename).
//   2. VERIFY the copy: same size and SHA-256 as the source, and the bytes still
//      parse as the image type they claim to be (JPEG / PNG / WebP).
//   3. Only when the copy is good, DELETE the source. The copy is now the original.
//   4. A bad copy is deleted and the copy is tried again, up to
//      settings.plantImages.copyMaxAttempts (5) times. After that the source is
//      left exactly where it was and the caller records the problem so the admin
//      can see it on the plants page.
//
// Deleting the source happens AFTER the database commit (FileMovePlan.finalize),
// never before: until then the row still points at the source, so a rollback or a
// crash can only ever leave an extra copy behind, never a row pointing at nothing.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');

const STATES = ['pending', 'approved', 'denied'];

// ---------------------------------------------------------------------------
// Folder layout
// ---------------------------------------------------------------------------

/**
 * Maps any status this project uses to one of the three folders.
 *   plant_images.status:          pending | approved | rejected
 *   approval_requests.status:     pending | approved | denied | rejected | cancelled
 * 'cancelled' has no folder: a withdrawn report's photos are deleted, not filed.
 */
function folderState(status) {
    switch (status) {
        case 'pending': return 'pending';
        case 'approved': return 'approved';
        case 'rejected':
        case 'denied': return 'denied';
        default: return null;
    }
}

/** Relative path (from plantImages.storageDir) of a plant photo's folder. */
function plantRelativeDir(status, key) {
    const state = folderState(status);
    if (!state || !key) throw new Error(`No plant photo folder for status "${status}"`);
    return path.join(settings.plantImages.plantSubdir, settings.plantImages.statusFolders[state], String(key));
}

/**
 * Relative path (from the DISCOVERY root, i.e. storageDir/discoveries) of a
 * report photo's folder. Relative to that root on purpose: every reader already
 * resolves storedPath against it.
 */
function discoveryRelativeDir(status, requestId) {
    const state = folderState(status);
    if (!state || !requestId) throw new Error(`No discovery photo folder for status "${status}"`);
    return path.join(settings.plantImages.statusFolders[state], String(requestId));
}

/**
 * Masters (the re-encoded, metadata-free WebP written by the upload pipeline) have
 * their own folder inside each image root, and unlike every other photo they never
 * change folder when the review status changes:
 *   under the plant root:     plants/masters/<plantId, or requestId for a new species>/<imageId>.webp
 *   under the discovery root: masters/<requestId>/<imageId>.webp
 * Both stay relative to their root, like every other storedPath.
 */
function plantMasterRelativeDir(key) {
    if (!key) throw new Error('A plant master folder needs a plantId or requestId');
    return path.join(settings.plantImages.plantSubdir, settings.plantImages.masterSubdir, String(key));
}

function discoveryMasterRelativeDir(requestId) {
    if (!requestId) throw new Error('A discovery master folder needs a requestId');
    return path.join(settings.plantImages.masterSubdir, String(requestId));
}

const pathParts = (relative) => path.normalize(String(relative || '')).split(path.sep);

/** True when a plant_images.storedPath is a master (so it must never be moved). */
function isPlantMasterPath(relative) {
    const parts = pathParts(relative);
    return parts.length >= 4 && parts[0] === settings.plantImages.plantSubdir && parts[1] === settings.plantImages.masterSubdir;
}

/** True when a discovery_images.storedPath is a master. */
function isDiscoveryMasterPath(relative) {
    const parts = pathParts(relative);
    return parts.length >= 3 && parts[0] === settings.plantImages.masterSubdir;
}

const plantRoot = () => settings.plantImages.storageDir;
const discoveryRoot = () => path.join(settings.plantImages.storageDir, settings.plantImages.discoverySubdir);

/** Creates plants/ and discoveries/ with their pending, approved and denied folders. */
function ensureImageTree() {
    const roots = [
        path.join(plantRoot(), settings.plantImages.plantSubdir),
        discoveryRoot()
    ];
    for (const root of roots) {
        for (const state of STATES) {
            fs.mkdirSync(path.join(root, settings.plantImages.statusFolders[state]), { recursive: true });
        }
    }
}

/** Removes a folder and its empty parents, stopping at (and keeping) `stopAt`. */
function pruneEmptyDirs(startDir, stopAt) {
    try {
        const stop = path.resolve(stopAt);
        let dir = path.resolve(startDir);
        while (dir.startsWith(stop + path.sep) && dir !== stop) {
            if (!fs.existsSync(dir) || fs.readdirSync(dir).length > 0) break;
            fs.rmdirSync(dir);
            dir = path.dirname(dir);
        }
    } catch (err) {
        console.error('Could not remove empty image folder:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Corruption check
// ---------------------------------------------------------------------------

let crcTable = null;
function crc32(buffer) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c;
        }
    }
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

function inspectPng(buf) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length < 45 || !buf.subarray(0, 8).equals(signature)) return 'not a PNG file';
    let pos = 8;
    let first = true;
    let sawData = false;
    while (pos + 12 <= buf.length) {
        const length = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        const end = pos + 12 + length;
        if (end > buf.length) return 'PNG is cut short';
        if (first && type !== 'IHDR') return 'PNG has no header chunk';
        first = false;
        const stored = buf.readUInt32BE(pos + 8 + length);
        if (crc32(buf.subarray(pos + 4, pos + 8 + length)) !== stored) return `PNG ${type} chunk is damaged`;
        if (type === 'IDAT') sawData = true;
        if (type === 'IEND') {
            if (!sawData) return 'PNG has no image data';
            return end === buf.length ? null : 'PNG has extra bytes after its end';
        }
        pos = end;
    }
    return 'PNG has no end marker';
}

function inspectJpeg(buf) {
    if (buf.length < 125 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return 'not a JPEG file';
    // Walk the header segments up to start-of-scan; each declares its own length.
    let pos = 2;
    let sawFrame = false;
    while (pos + 4 <= buf.length) {
        if (buf[pos] !== 0xff) return 'JPEG segment markers are damaged';
        let marker = buf[pos + 1];
        while (marker === 0xff && pos + 2 < buf.length) { pos++; marker = buf[pos + 1]; }
        if (marker === 0xd9) break;
        if (marker >= 0xd0 && marker <= 0xd7) { pos += 2; continue; }
        const length = buf.readUInt16BE(pos + 2);
        if (length < 2 || pos + 2 + length > buf.length) return 'JPEG is cut short';
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) sawFrame = true;
        if (marker === 0xda) {
            if (!sawFrame) return 'JPEG has no frame header';
            // Entropy-coded data follows; the file must still end with EOI
            // (allowing the zero padding some cameras append).
            let tail = buf.length;
            while (tail > 0 && buf[tail - 1] === 0x00) tail--;
            return tail >= 2 && buf[tail - 2] === 0xff && buf[tail - 1] === 0xd9
                ? null
                : 'JPEG has no end marker (cut short)';
        }
        pos += 2 + length;
    }
    return 'JPEG has no image data';
}

function inspectWebp(buf) {
    if (buf.length < 30) return 'not a WebP file';
    if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return 'not a WebP file';
    if (buf.readUInt32LE(4) + 8 !== buf.length) return 'WebP size does not match the file (cut short or padded)';
    return null;
}

/**
 * Returns null when the bytes are a structurally sound image, else a short reason.
 * No image library is required: PNG chunks are CRC-checked, JPEG segments are
 * walked and its end marker checked, WebP's RIFF length is checked against the
 * file. That catches truncation, zero-filled and half-written files, which is
 * what a failed copy looks like.
 */
function inspectImageBuffer(buf, mimeType, filename) {
    const ext = path.extname(filename || '').toLowerCase();
    const kind = /png/i.test(mimeType || '') || ext === '.png' ? 'png'
        : /webp/i.test(mimeType || '') || ext === '.webp' ? 'webp'
            : 'jpeg';
    return kind === 'png' ? inspectPng(buf) : kind === 'webp' ? inspectWebp(buf) : inspectJpeg(buf);
}

async function inspectImageFile(file, mimeType) {
    return inspectImageBuffer(await fsp.readFile(file), mimeType, file);
}

// ---------------------------------------------------------------------------
// Verified copy
// ---------------------------------------------------------------------------

async function sha256(file) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', resolve);
    });
    return hash.digest('hex');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(file) {
    try { await fsp.access(file); return true; } catch (err) { return false; }
}

/**
 * Copies `source` to `destination` and verifies the copy. Never touches the
 * source. Retries a bad copy; a bad copy is always deleted before the next try.
 *
 * Returns { ok, attempts, error, alreadyThere }.
 *   - source missing but a valid copy already at the destination -> ok (a
 *     previous run got that far).
 *   - source missing and nothing at the destination -> fails at once: there is
 *     nothing to copy, so retrying cannot help.
 */
async function copyVerified(source, destination, { mimeType, attempts, delayMs, fsImpl } = {}) {
    const max = attempts || settings.plantImages.copyMaxAttempts;
    const delay = delayMs === undefined ? settings.plantImages.copyRetryDelayMs : delayMs;
    const f = fsImpl || fsp;

    if (path.resolve(source) === path.resolve(destination)) {
        return { ok: true, attempts: 0, alreadyThere: true };
    }

    if (!(await exists(source))) {
        if (await exists(destination)) {
            const problem = await inspectImageFile(destination, mimeType).catch((e) => e.message);
            if (!problem) return { ok: true, attempts: 0, alreadyThere: true };
        }
        return { ok: false, attempts: 0, error: 'the source file is missing' };
    }

    await fsp.mkdir(path.dirname(destination), { recursive: true });
    let lastError = 'unknown error';

    for (let attempt = 1; attempt <= max; attempt++) {
        try {
            await f.copyFile(source, destination);
            const [a, b] = await Promise.all([fsp.stat(source), fsp.stat(destination)]);
            if (a.size !== b.size) throw new Error(`copy is ${b.size} bytes, source is ${a.size}`);
            if ((await sha256(source)) !== (await sha256(destination))) throw new Error('copy does not match the source');
            const problem = await inspectImageFile(destination, mimeType);
            if (problem) throw new Error(problem);
            return { ok: true, attempts: attempt };
        } catch (err) {
            lastError = err.message;
            await fsp.unlink(destination).catch(() => {});
            if (attempt < max && delay > 0) await sleep(delay * attempt);
        }
    }
    // Nothing was kept: drop the destination folder if the failed copy made it.
    await fsp.rmdir(path.dirname(destination)).catch(() => {});
    return { ok: false, attempts: max, error: lastError };
}

// ---------------------------------------------------------------------------
// FileMovePlan: copies now, source deletion after the commit
// ---------------------------------------------------------------------------

class FileMovePlan {
    constructor(options = {}) {
        this.options = options;
        this.items = [];
        this.state = 'open';
    }

    /**
     * Copy + verify. `deleteSource: false` keeps the source (used when a report
     * photo is attached to a plant record: the report keeps its own photo).
     * Returns the copyVerified result.
     */
    async stage(source, destination, { mimeType, deleteSource = true } = {}) {
        const result = await copyVerified(source, destination, { ...this.options, mimeType });
        if (result.ok && !result.alreadyThere) {
            this.items.push({ source, destination, deleteSource });
        } else if (result.ok && result.alreadyThere && deleteSource && path.resolve(source) !== path.resolve(destination)) {
            this.items.push({ source, destination, deleteSource, adopted: true });
        }
        return result;
    }

    /** Call right after the database commit. Deletes the sources; the copies are now the originals. */
    async finalize() {
        if (this.state !== 'open') return;
        this.state = 'committed';
        for (const item of this.items) {
            if (!item.deleteSource) continue;
            try {
                await fsp.unlink(item.source);
            } catch (err) {
                if (err.code !== 'ENOENT') console.error('Could not delete the old copy of a moved photo:', item.source, err.message);
            }
        }
    }

    /** Call when the transaction rolled back: the copies are removed, the sources were never touched. */
    async rollback() {
        if (this.state !== 'open') return;
        this.state = 'rolledback';
        for (const item of this.items) {
            if (item.adopted) continue;
            await fsp.unlink(item.destination).catch(() => {});
            await fsp.rmdir(path.dirname(item.destination)).catch(() => {});
        }
    }

    /** Folders to tidy after finalize(): the emptied source folders. */
    sourceDirs() {
        return [...new Set(this.items.filter((i) => i.deleteSource).map((i) => path.dirname(i.source)))];
    }
}

module.exports = {
    STATES,
    folderState,
    plantRelativeDir,
    discoveryRelativeDir,
    plantMasterRelativeDir,
    discoveryMasterRelativeDir,
    isPlantMasterPath,
    isDiscoveryMasterPath,
    plantRoot,
    discoveryRoot,
    ensureImageTree,
    pruneEmptyDirs,
    inspectImageBuffer,
    inspectImageFile,
    copyVerified,
    FileMovePlan
};
