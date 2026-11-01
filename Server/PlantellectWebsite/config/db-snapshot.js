// Database snapshot of the training photos (dataset handler).
//
// Reads every APPROVED photo whose trainingStatus is 'included' and writes a new numbered folder:
//
//   datasets/db-snapshots/snapshot-YYYYMMDD-HHMMSS/
//     Plant/<Species name>/<Part>/<imageId>.webp      species the active model supports (or promoted)
//     Plant/<Species name>/<imageId>.webp             ... when the photo has no part yet
//     Other plant/<Species name>/<imageId>.webp       species the model does not list yet
//     manifest.json    one entry per photo: ids, names, kind, part, group, SHA-256 of the file
//     groups.csv       photos that must stay in one split: header "group,path", path = SHA-256 of the file
//     summary.json     counts and warnings (what the admin page lists)
//
// The layout is exactly the "pool tree" the dataset scanner already reads, so the folder works
// unchanged with the audit and the split script (`split --snapshot <folder>`); the manifest and the group
// file add what a folder cannot say.
//
// Rules
//   * Kind: a species the active model lists is Plant, a species an admin promoted is Plant (it is filed
//     there before the retrain, so the next model can learn it), everything else is Other plant. Other
//     plant photos are capped per species (settings.dataset.otherPlantCap) so a few species cannot make up
//     most of the one Other plant class; the photos left out are counted and reported, never hidden.
//   * Archiving or hiding a photo does not remove it from a snapshot: archive and dataset exclusion
//     are two separate buttons (plan section 6). Only status 'approved', trainingStatus 'included' and
//     a master that still exists count.
//   * A snapshot is never edited and never mixed with another. It is built in a hidden folder and
//     renamed into place last, so a half-written snapshot never looks finished.
//   * Files are hard-linked from the masters (copied when the drive cannot link). Masters are written
//     once and never change, so a link stays valid even after the master is later deleted.
//   * No personal data: no account, no original filename, no photo metadata. Masters carry none.
//   * Groups: photos of one plant are joined when they share a manual groupKey or came in the same
//     submission (the same approval request). Photos in neither stay alone and are grouped by the split
//     script from how alike they look.
//
// The database, the class list and the clock are injected (`deps`) so this can be tested without MySQL.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const settings = require('./settings');

const KIND_FOLDER = { species: 'Plant', other_plant: 'Other plant' };
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL',
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

const fail = (error, code = 400, extra = {}) => ({ error, code, ...extra });
let building = false;

/** Same rule as dataset_tools/names.py: only the first character is capitalised. */
function normalizeName(name) {
    const s = String(name).split(/\s+/).filter(Boolean).join(' ');
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** A name Windows accepts as a folder (port of dataset_tools/names.py safe_folder_name). */
function safeFolderName(name, maxLen = 100) {
    let s = normalizeName(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[ .]+$/, '');
    s = Array.from(s).slice(0, maxLen).join('').replace(/[ .]+$/, '');
    if (!s) return '_';
    if (RESERVED.has(s.split('.')[0].toUpperCase())) s += '_';
    return s;
}

/** The master file of a plant_images row, or null when its path leaves the image root. */
function masterFileOf(storageDir, storedPath) {
    const base = path.resolve(storageDir);
    const file = path.resolve(base, String(storedPath || ''));
    return file.startsWith(base + path.sep) ? file : null;
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file).on('error', reject).on('data', (c) => hash.update(c))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function resolveDeps(deps = {}) {
    return {
        db: deps.db || require('./pool-mysql').mysqlPool,
        loadClasses: deps.loadClasses || (() => require('./active-classes').loadActiveClasses()),
        storageDir: deps.storageDir || settings.plantImages.storageDir,
        outRoot: deps.outRoot || path.join(settings.dataset.dir, settings.dataset.snapshotSubdir),
        now: deps.now || (() => new Date()),
        copyOnly: Boolean(deps.copyOnly),
        otherPlantCap: deps.otherPlantCap !== undefined ? deps.otherPlantCap : settings.dataset.otherPlantCap
    };
}

/** Same rule as config/species-promotion.js, so a species that shows as Supported there is filed under Plant here. */
const nameKey = (value) => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * 'species' for a species the model lists or an admin promoted, 'other_plant' for the rest. The model comes
 * first, as on the promotion page ("supported wins over everything"): a promotion that was undone and a
 * species that has since entered the model must not stay Other plant. classNames is null when the class list
 * could not be read; only a species with no decision at all is refused then (see buildSnapshot).
 */
function kindOf(row, classNames) {
    if (classNames && classNames.has(nameKey(row.scientificName))) return 'species';
    return row.speciesStatus === 'promoted' ? 'species' : 'other_plant';
}

/**
 * Keeps at most `cap` Other plant photos of each species. Which ones is decided by a hash of the image id, so
 * the choice is the same on every build and does not favour old or new photos. Plant photos are never capped.
 * Returns { kept, dropped, species } (species = how many species lost photos). cap 0 means no cap.
 */
function capOtherPlant(entries, cap) {
    if (!cap || cap < 1) return { kept: entries, dropped: 0, species: 0 };
    const byPlant = new Map();
    for (const e of entries) {
        if (e.kind !== 'other_plant') continue;
        if (!byPlant.has(e.plantId)) byPlant.set(e.plantId, []);
        byPlant.get(e.plantId).push(e);
    }
    const drop = new Set();
    let species = 0;
    for (const list of byPlant.values()) {
        if (list.length <= cap) continue;
        species += 1;
        list.map((e) => ({ e, key: crypto.createHash('sha256').update(String(e.imageId)).digest('hex') }))
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .slice(cap).forEach((x) => drop.add(x.e.imageId));
    }
    return { kept: entries.filter((e) => !drop.has(e.imageId)), dropped: drop.size, species };
}

/** Joins photos of ONE plant that share a manual group or a submission. Returns imageId -> group name. */
function buildGroups(entries) {
    const parent = new Map(entries.map((e) => [e.imageId, e.imageId]));
    const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };

    const byKey = new Map();
    const link = (key, imageId) => {
        if (byKey.has(key)) union(byKey.get(key), imageId); else byKey.set(key, imageId);
    };
    for (const e of entries) {
        if (e.groupKey) link(`m|${e.plantId}|${e.groupKey}`, e.imageId);
        if (e.submission) link(`s|${e.plantId}|${e.submission}`, e.imageId);
    }
    const comps = new Map();
    for (const e of entries) {
        const root = find(e.imageId);
        if (!comps.has(root)) comps.set(root, []);
        comps.get(root).push(e);
    }
    const names = new Map();
    for (const members of comps.values()) {
        if (members.length < 2) continue;
        const manual = members.map((m) => m.groupKey).filter(Boolean).sort();
        const subs = members.map((m) => m.submission).filter(Boolean).sort();
        const name = manual.length ? `m:${manual[0]}` : `s:${subs[0]}`;
        for (const m of members) names.set(m.imageId, name);
    }
    return names;
}

async function loadRows(db) {
    const [rows] = await db.query(
        `SELECT i.imageId, i.plantId, i.storedPath, i.part, i.groupKey, i.contentHash,
                p.scientificName, p.commonName, ss.status AS speciesStatus
         FROM plant_images i
         JOIN plants p ON p.plantId = i.plantId
         LEFT JOIN species_status ss ON ss.plantId = p.plantId
         WHERE i.status = 'approved' AND i.trainingStatus = 'included'
           AND i.masterPurgedAt IS NULL AND i.plantId IS NOT NULL
         ORDER BY p.scientificName, i.imageId`
    );
    return rows;
}

/** imageId -> the approval request it was submitted with (the smallest id if it is in several). */
async function loadSubmissions(db, imageIds) {
    const wanted = new Set(imageIds);
    const [requests] = await db.query(
        `SELECT requestId, payload FROM approval_requests
         WHERE requestType IN ('plant_addition', 'plant_contribution') AND payload IS NOT NULL`
    );
    const out = new Map();
    for (const r of requests) {
        let payload = r.payload;
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { continue; } }
        const ids = payload && Array.isArray(payload.imageIds) ? payload.imageIds : [];
        for (const id of ids) {
            if (wanted.has(id) && (!out.has(id) || r.requestId < out.get(id))) out.set(id, r.requestId);
        }
    }
    return out;
}

async function placeFile(source, dest, copyOnly) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (!copyOnly) {
        try { await fsp.link(source, dest); return; } catch (_) { /* another drive, or no link support: copy */ }
    }
    await fsp.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
}

/**
 * Builds a new snapshot folder. Returns { ok, name, dir, counts, warnings, skipped } or { error, code }.
 */
async function buildSnapshot(options = {}, deps) {
    if (building) return fail('A snapshot is already being built', 409);
    building = true;
    const d = resolveDeps(deps);
    let partial = null;
    try {
        const rows = await loadRows(d.db);
        if (rows.length === 0) {
            return fail('No photo is marked as included for training yet. Mark approved photos as included first.', 409);
        }

        // Which species does the model support? A promoted species is Plant without asking; every other species
        // is checked against the model, which also catches a species that entered the model after an undo.
        let classNames = null;
        let classListUnread = false;
        if (rows.some((r) => r.speciesStatus !== 'promoted')) {
            const classes = await d.loadClasses();
            if (classes) {
                classNames = new Set(classes.map((c) => nameKey(c.scientific)));
            } else if (rows.some((r) => !r.speciesStatus)) {
                return fail("The active model's class list could not be read, so supported species cannot be told apart from Other plant. " +
                    'Fix the model folder, or promote the species first.', 503);
            } else {
                classListUnread = true;   // every species has a decision, so the build can go on
            }
        }
        const submissions = await loadSubmissions(d.db, rows.map((r) => r.imageId));

        const warnings = [];
        const skipped = [];
        let entries = [];
        for (const r of rows) {
            const source = masterFileOf(d.storageDir, r.storedPath);
            let missing = !source;
            if (source) { try { missing = !(await fsp.stat(source)).isFile(); } catch (_) { missing = true; } }
            if (missing) { skipped.push({ imageId: r.imageId, reason: 'the master file is missing' }); continue; }
            entries.push({
                imageId: r.imageId, plantId: r.plantId, scientificName: r.scientificName, commonName: r.commonName,
                kind: kindOf(r, classNames), part: r.part || null, groupKey: r.groupKey || null,
                submission: submissions.get(r.imageId) || null, uploadHash: r.contentHash || null, source
            });
        }
        if (entries.length === 0) return fail('Every included photo has lost its file, so there is nothing to export.', 409);

        const capResult = capOtherPlant(entries, d.otherPlantCap);
        entries = capResult.kept;

        // Two species that Windows would store in one folder must never be merged silently.
        const folders = new Map();
        for (const e of entries) {
            e.folder = safeFolderName(e.scientificName);
            const key = `${e.kind}|${e.folder.toLowerCase()}`;
            if (!folders.has(key)) folders.set(key, new Set());
            folders.get(key).add(e.scientificName);
        }
        for (const names of folders.values()) {
            if (names.size > 1) {
                return fail(`These species would share one folder, so the snapshot was not built: ${[...names].join(' / ')}`, 409);
            }
        }

        await fsp.mkdir(d.outRoot, { recursive: true });
        const base = `snapshot-${stamp(d.now())}`;
        let name = base;
        for (let n = 2; fs.existsSync(path.join(d.outRoot, name)) || fs.existsSync(path.join(d.outRoot, `.${name}.partial`)); n++) {
            name = `${base}-${n}`;
        }
        partial = path.join(d.outRoot, `.${name}.partial`);
        await fsp.mkdir(partial);

        // Groups are decided per plant, then named; the file hash ties a group to its photos.
        const groupNames = new Map();
        const byPlant = new Map();
        for (const e of entries) {
            if (!byPlant.has(e.plantId)) byPlant.set(e.plantId, []);
            byPlant.get(e.plantId).push(e);
        }
        for (const list of byPlant.values()) for (const [id, g] of buildGroups(list)) groupNames.set(id, g);

        for (const e of entries) {
            const parts = [KIND_FOLDER[e.kind], e.folder];
            if (e.kind === 'species' && e.part) parts.push(safeFolderName(e.part));
            e.rel = [...parts, `${e.imageId}.webp`].join('/');
            const dest = path.join(partial, ...parts, `${e.imageId}.webp`);
            await placeFile(e.source, dest, d.copyOnly);
            e.sha256 = await sha256File(dest);
        }

        const species = entries.filter((e) => e.kind === 'species');
        const noPart = species.filter((e) => !e.part);
        if (noPart.length) {
            warnings.push(`${noPart.length} photo(s) of supported species have no part. They are filed directly under the species folder; give them a part for the part report.`);
        }
        if (capResult.dropped) {
            warnings.push(`${capResult.dropped} Other plant photo(s) of ${capResult.species} species were left out by the cap of ${d.otherPlantCap} photos per species ` +
                '(DATASET_OTHER_PLANT_CAP; 0 means no cap).');
        }
        if (classListUnread) {
            warnings.push("The active model's class list could not be read, so species with an Other plant decision were kept as Other plant even if the model lists them now.");
        }
        if (skipped.length) warnings.push(`${skipped.length} included photo(s) were left out because their file is missing.`);

        const groupRows = entries.filter((e) => groupNames.has(e.imageId))
            .map((e) => `${csvCell(groupNames.get(e.imageId))},${csvCell(e.sha256)}`);
        await fsp.writeFile(path.join(partial, 'groups.csv'), ['group,path', ...groupRows].join('\n') + '\n', 'utf8');

        const createdAt = d.now().toISOString();
        const counts = {
            photos: entries.length,
            species: new Set(species.map((e) => e.plantId)).size,
            otherPlantSpecies: new Set(entries.filter((e) => e.kind === 'other_plant').map((e) => e.plantId)).size,
            otherPlantPhotos: entries.length - species.length,
            otherPlantCapped: capResult.dropped,
            noPart: noPart.length,
            groups: new Set(groupNames.values()).size,
            skipped: skipped.length
        };
        const manifest = {
            version: 1, name, createdAt, counts, skipped, limits: { otherPlantCap: d.otherPlantCap || 0 },
            photos: entries.map((e) => ({
                imageId: e.imageId, plantId: e.plantId, scientificName: e.scientificName, commonName: e.commonName,
                kind: e.kind, part: e.part, manualGroup: e.groupKey, submission: e.submission,
                group: groupNames.get(e.imageId) || null, sha256: e.sha256, uploadHash: e.uploadHash, path: e.rel
            }))
        };
        await fsp.writeFile(path.join(partial, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
        await fsp.writeFile(path.join(partial, 'summary.json'), JSON.stringify({ version: 1, name, createdAt, counts, warnings }, null, 1), 'utf8');

        await fsp.rename(partial, path.join(d.outRoot, name));
        partial = null;
        await fsp.writeFile(path.join(d.outRoot, 'latest.txt'), name, 'utf8');
        return { ok: true, name, dir: path.join(d.outRoot, name), createdAt, counts, warnings, skipped };
    } finally {
        if (partial) await fsp.rm(partial, { recursive: true, force: true }).catch(() => {});
        building = false;
    }
}

/** The snapshots on disk, newest first, from their small summary files. */
async function listSnapshots(deps) {
    const d = resolveDeps(deps);
    let names = [];
    try {
        names = (await fsp.readdir(d.outRoot, { withFileTypes: true }))
            .filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    const out = [];
    for (const name of names) {
        try {
            const s = JSON.parse(await fsp.readFile(path.join(d.outRoot, name, 'summary.json'), 'utf8'));
            out.push({ name, createdAt: s.createdAt, counts: s.counts, warnings: s.warnings || [] });
        } catch (_) { /* not one of ours, or unfinished */ }
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = { buildSnapshot, listSnapshots, safeFolderName, normalizeName, buildGroups, kindOf, capOtherPlant };
