// Species promotion.
//
// A species whose approved photos the active model does not know yet is "Other plant".
// An admin can PROMOTE it once it has enough unique photos. Promoting only records the
// decision (species_status). Nothing changes for scans until a retrained model's
// classes.json lists the species; from then on the species shows as SUPPORTED.
//
// Three states, worked out on every read and never stored as "supported":
//
//   supported   the active model's classes.json lists the species (wins over everything)
//   promoted    an admin decided to promote it; waiting for a retrain
//   other_plant everything else that has eligible photos
//
// What counts as a photo here: approved, not archived, not excluded from training, master
// still on disk, and the plant is not archived. publicVisible does NOT matter: a photo can
// be hidden from the public and still be good training data.
//
// "Unique" photos: identical SHA-256 counts once, and photos whose dHashes differ by at most
// settings.lookalike.hashMaxDistance bits count once too. That threshold is uncalibrated
// so the number is a guide. Chains link (A~B, B~C gives one photo), which can
// only make the count lower, and a lower count only delays a promotion.
//
// The class list is read from the same file as the database snapshot and the admin coverage route
// (config/active-classes.js), so the promotion page and a snapshot always agree on "supported".

const fs = require('fs');
const settings = require('./settings');
const { hamming } = require('./lookalike');

const defaultExecutor = () => require('./pool-mysql').mysqlPool;

const PLANT_ID = /^[A-Za-z0-9_-]{1,18}$/;
const STATE_ORDER = { promoted: 0, other_plant: 1, supported: 2 };
const NOTE_MAX = 255;

/** An error whose message is safe to show the admin. */
class SpeciesError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
        this.expose = true;
    }
}

/** The key two names are compared by: case, spacing and Unicode form never matter. */
const nameKey = (value) => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

// ---------------------------------------------------------------------------
// The active model's class list
// ---------------------------------------------------------------------------

let classesCache = { file: null, mtimeMs: null, value: null };

/** The class set of the ACTIVE model (see config/active-classes.js), or null when it cannot be read. */
async function loadActiveClassSet(getSystemSetting) {
    const { resolveClassesPath } = require('./active-classes');
    return readActiveClasses(await resolveClassesPath(getSystemSetting));
}

/**
 * The species the active model knows, as { names: Set of nameKey, count }, or null when the
 * list cannot be read. Null means "cannot check", never "no species". Re-read whenever the
 * file's modified time changes, so a new model shows up without restarting the server.
 *
 * Only entries of kind 'species' count (a missing kind means species, as in older models).
 * The "Other plant" and "Non plant" classes are not species and never match a plant.
 */
function readActiveClasses(file = settings.speciesPromotion.classesPath) {
    try {
        const stat = fs.statSync(file);
        if (classesCache.file === file && classesCache.mtimeMs === stat.mtimeMs) return classesCache.value;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const entries = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
        const names = new Set();
        for (const entry of entries) {
            const item = typeof entry === 'string' ? { scientific: entry } : entry;
            if (!item || !item.scientific) continue;
            if ((item.kind || 'species') !== 'species') continue;
            names.add(nameKey(item.scientific));
        }
        const value = names.size > 0 ? { names, count: names.size } : null;
        classesCache = { file, mtimeMs: stat.mtimeMs, value };
        return value;
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Species promotion: could not read classes.json:', err.message);
        classesCache = { file: null, mtimeMs: null, value: null };
        return null;
    }
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * Counts one plant's eligible photos. rows: { imageId, accountId, creditAccountId,
 * contentHash, perceptualHash }.
 *
 * A photo without a hash (stored before the ingest pipeline) always counts as its own
 * photo: it cannot be shown to be a copy.
 */
function countPhotos(rows, maxDistance = settings.lookalike.hashMaxDistance) {
    const byExact = new Map();
    for (const row of rows) {
        const key = row.contentHash ? `h:${row.contentHash}` : `i:${row.imageId}`;
        const found = byExact.get(key);
        if (!found) byExact.set(key, { perceptualHash: row.perceptualHash || null });
        else if (!found.perceptualHash && row.perceptualHash) found.perceptualHash = row.perceptualHash;
    }

    const reps = [...byExact.values()];
    const parent = reps.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let a = 0; a < reps.length; a++) {
        if (!reps[a].perceptualHash) continue;
        for (let b = a + 1; b < reps.length; b++) {
            if (!reps[b].perceptualHash) continue;
            const distance = hamming(reps[a].perceptualHash, reps[b].perceptualHash);
            if (distance !== null && distance <= maxDistance) parent[find(a)] = find(b);
        }
    }
    const unique = new Set(reps.map((_, i) => find(i))).size;

    const people = new Set();
    for (const row of rows) {
        if (row.accountId) people.add(row.accountId);
        if (row.creditAccountId) people.add(row.creditAccountId);
    }
    return { approvedPhotos: rows.length, exactUnique: byExact.size, uniquePhotos: unique, contributors: people.size };
}

/** The WHERE conditions that decide which photos feed a species' count. */
const ELIGIBLE_SQL =
    "i.status = 'approved' AND i.archivedAt IS NULL AND i.trainingStatus <> 'excluded' " +
    'AND i.masterPurgedAt IS NULL AND p.archivedAt IS NULL';

/**
 * Every species with at least one eligible photo, or with a promotion on record, as one
 * entry per plant: { plant, decision, rows }. plantId narrows it to one plant.
 */
async function gather(db, plantId = null) {
    const bySpecies = new Map();
    const entryFor = (r) => {
        if (!bySpecies.has(r.plantId)) {
            bySpecies.set(r.plantId, {
                plantId: r.plantId, scientificName: r.scientificName, commonName: r.commonName,
                decision: r.decision || null, decidedAt: r.decidedAt || null, note: r.note || null, rows: []
            });
        }
        return bySpecies.get(r.plantId);
    };

    const [photos] = await db.query(
        `SELECT i.imageId, i.plantId, i.accountId, i.creditAccountId, i.contentHash, i.perceptualHash,
                p.scientificName, p.commonName, s.status AS decision, s.decidedAt, s.note
         FROM plant_images i
         JOIN plants p ON p.plantId = i.plantId
         LEFT JOIN species_status s ON s.plantId = p.plantId
         WHERE ${ELIGIBLE_SQL}${plantId ? ' AND i.plantId = ?' : ''}`,
        plantId ? [plantId] : []
    );
    for (const r of photos) entryFor(r).rows.push(r);

    // A promoted species must stay in the list even if its photos stopped being eligible,
    // otherwise nobody could undo the promotion.
    const [promoted] = await db.query(
        `SELECT p.plantId, p.scientificName, p.commonName, s.status AS decision, s.decidedAt, s.note
         FROM species_status s
         JOIN plants p ON p.plantId = s.plantId
         WHERE s.status = 'promoted' AND p.archivedAt IS NULL${plantId ? ' AND s.plantId = ?' : ''}`,
        plantId ? [plantId] : []
    );
    for (const r of promoted) entryFor(r);

    return [...bySpecies.values()];
}

function describeSpecies(entry, classes) {
    const counts = countPhotos(entry.rows);
    const minimum = settings.speciesPromotion.minUniquePhotos;
    let state = 'other_plant';
    if (classes && classes.names.has(nameKey(entry.scientificName))) state = 'supported';
    else if (entry.decision === 'promoted') state = 'promoted';
    const minimumMet = counts.uniquePhotos >= minimum;
    return {
        plantId: entry.plantId, scientificName: entry.scientificName, commonName: entry.commonName,
        state, ...counts, nearCopies: counts.exactUnique - counts.uniquePhotos,
        minimum, minimumMet,
        canPromote: state === 'other_plant' && minimumMet && !!classes,
        canUndo: state === 'promoted',
        decidedAt: entry.decidedAt, note: entry.note
    };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The promotion table. state filters to one state; the summary always counts all of them.
 * Sorted promoted first, then Other plant (most unique photos first), then supported.
 */
async function listSpecies(db, { state = '', page = 1, pageSize = 25, classes = readActiveClasses() } = {}) {
    const all = (await gather(db)).map((entry) => describeSpecies(entry, classes));
    const summary = { promoted: 0, other_plant: 0, supported: 0 };
    all.forEach((s) => { summary[s.state] += 1; });

    const wanted = STATE_ORDER[state] !== undefined ? all.filter((s) => s.state === state) : all;
    wanted.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
        || b.uniquePhotos - a.uniquePhotos
        || a.scientificName.localeCompare(b.scientificName));

    const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25));
    const current = Math.max(1, parseInt(page, 10) || 1);
    return {
        species: wanted.slice((current - 1) * size, current * size),
        total: wanted.length, page: current, pageSize: size, summary,
        minimum: settings.speciesPromotion.minUniquePhotos,
        classesAvailable: !!classes,
        modelSpecies: classes ? classes.count : null
    };
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

const cleanNote = (note) => (typeof note === 'string' ? note.trim().slice(0, NOTE_MAX) : '') || null;

async function loadOne(db, plantId, classes) {
    if (!PLANT_ID.test(String(plantId || ''))) throw new SpeciesError(400, 'Bad request');
    const [plants] = await db.query('SELECT plantId, scientificName, archivedAt FROM plants WHERE plantId = ?', [plantId]);
    if (!plants[0]) throw new SpeciesError(404, 'Plant not found');
    if (plants[0].archivedAt) throw new SpeciesError(409, 'This plant is archived');
    const entries = await gather(db, plantId);
    const entry = entries[0] || {
        plantId, scientificName: plants[0].scientificName, commonName: null, decision: null, decidedAt: null, note: null, rows: []
    };
    return describeSpecies(entry, classes);
}

/**
 * Records the decision to promote. Refused when the model's class list cannot be read (the
 * species might already be supported), when the species is already supported, and when it
 * has fewer unique photos than the minimum. Promoting twice is not an error.
 */
async function promoteSpecies(db, { plantId, accountId, note, classes = readActiveClasses() }) {
    if (!classes) throw new SpeciesError(409, "The active model's class list cannot be read, so the server cannot tell whether this species is already supported.");
    const species = await loadOne(db, plantId, classes);
    if (species.state === 'supported') throw new SpeciesError(409, 'The active model already lists this species.');
    if (species.state === 'promoted') return { changed: false, species };
    if (!species.minimumMet) {
        throw new SpeciesError(409, `Only ${species.uniquePhotos} unique photo(s); at least ${species.minimum} are needed before a species is promoted.`);
    }
    const text = cleanNote(note);
    await db.query(
        `INSERT INTO species_status (plantId, status, decidedBy, decidedAt, note)
         VALUES (?, 'promoted', ?, NOW(), ?)
         ON DUPLICATE KEY UPDATE status = 'promoted', decidedBy = ?, decidedAt = NOW(), note = ?`,
        [plantId, accountId, text, accountId, text]
    );
    return { changed: true, species: { ...species, state: 'promoted', canPromote: false, canUndo: true, note: text } };
}

/** Takes a promotion back, while the model does not list the species yet. */
async function undoPromotion(db, { plantId, accountId, note, classes = readActiveClasses() }) {
    if (!classes) throw new SpeciesError(409, "The active model's class list cannot be read.");
    const species = await loadOne(db, plantId, classes);
    if (species.state === 'supported') throw new SpeciesError(409, 'The active model already lists this species, so there is nothing to undo.');
    if (species.state !== 'promoted') throw new SpeciesError(409, 'This species is not promoted.');
    const text = cleanNote(note);
    const [result] = await db.query(
        `UPDATE species_status SET status = 'other_plant', decidedBy = ?, decidedAt = NOW(), note = ?
         WHERE plantId = ? AND status = 'promoted'`,
        [accountId, text, plantId]
    );
    if (!result || result.affectedRows === 0) throw new SpeciesError(409, 'This species is not promoted.');
    return { changed: true, species: { ...species, state: 'other_plant', canPromote: species.minimumMet, canUndo: false, note: text } };
}

module.exports = {
    SpeciesError, nameKey, readActiveClasses, loadActiveClassSet, countPhotos,
    listSpecies, promoteSpecies, undoPromotion, defaultExecutor,
    ELIGIBLE_SQL
};
