// Helpers, normalisation, taxonomy, plant_parts column set and model class list shared by the other mysql modules.
// Split out of mysql.js; see mysql.js for the combined export list.

const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const { insertRow } = require('./ids.js');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Clamps pagination input against settings.pagination. Never throws and never
 * honours an oversized page size; a page past the end simply returns no rows.
 */
function parsePaging(query) {
    const { defaultPageSize, maxPageSize } = settings.pagination;
    const rawPage = parseInt(query.page, 10);
    const rawSize = parseInt(query.pageSize, 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    let pageSize = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : defaultPageSize;
    if (pageSize > maxPageSize) pageSize = maxPageSize;
    return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Escapes LIKE wildcards so a literal % or _ does not match everything. */
function escapeLike(term) {
    return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// Shared normalisation
// ---------------------------------------------------------------------------

/** Trims and collapses internal whitespace to a single space. */
function normalizeName(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim().replace(/\s+/g, ' ');
}

/**
 * For free-text descriptions (uses, benefits, caution notes). Unlike normalizeName it KEEPS
 * line breaks, because a botanist's Enter key is a paragraph or bullet break, and the
 * formatting marks (**bold**, ==highlight==, \\n ...) read by public/javascript/richtext.js.
 * It still tidies: CRLF -> LF, trailing spaces, runs of 3+ blank lines -> one blank line.
 */
function normalizeRichText(value) {
    if (value === undefined || value === null) return '';
    return String(value)
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** scientificName is a machine identifier, so trailing noise is stripped too. */
function normalizeScientificName(value) {
    return normalizeName(value).replace(/\.+$/, '').trim();
}

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * The sentinel for a taxonomy level the botanist did not supply. It has to read
 * as a gap: 'Lamiaceae' reads as a fact nobody will correct, 'Unspecified'
 * does not. kingdom and phylum default to the two values that are right for
 * every plant in this project, so they never carry the sentinel.
 */
const UNSPECIFIED_TAXONOMY = 'Unspecified';

// kingdom and phylum are excluded on purpose: they default correctly, so
// including them in the gap test would match every row and make the filter
// useless.
const TAXONOMY_GAP_LEVELS = ['class', 'order', 'family', 'genus', 'species'];

// Every column of the taxonomy table, in rank order. The one list the draft
// builder, the taxonomy-update request and its approval all read, so a level
// cannot be added to one and forgotten in another.
const TAXONOMY_LEVELS = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'];

const TAXONOMY_DEFAULTS = {
    kingdom: 'Plantae',
    phylum: 'Tracheophyta',
    class: UNSPECIFIED_TAXONOMY,
    order: UNSPECIFIED_TAXONOMY,
    family: UNSPECIFIED_TAXONOMY,
    genus: UNSPECIFIED_TAXONOMY,
    species: UNSPECIFIED_TAXONOMY
};

/** Every level is normalised independently; none of them derives from another. */
function buildTaxonomyRow(payload) {
    const pick = (key, ...fallbackKeys) => {
        for (const candidate of [key, ...fallbackKeys]) {
            const cleaned = normalizeName(payload[candidate]);
            if (cleaned) return cleaned;
        }
        return TAXONOMY_DEFAULTS[key];
    };
    return {
        kingdom: pick('kingdom'),
        phylum: pick('phylum'),
        class: pick('class', 'plantClass'),
        order: pick('order'),
        family: pick('family'),
        genus: pick('genus'),
        species: pick('species')
    };
}

// ---------------------------------------------------------------------------
// plant_parts column set
// ---------------------------------------------------------------------------

// The measurements block. Shared by the two detail readers so "is this
// description actually carrying measurements" is decided the same way in both.
const PARTS_FIELDS = [
    'heightMinCm', 'heightMaxCm', 'heightNote',
    'widthMinCm', 'widthMaxCm', 'widthNote',
    'color', 'shape', 'texture'
];

const PARTS_SELECT = PARTS_FIELDS.map((f) => `pp.${f}`).join(', ');

function partsFromRow(r) {
    const populated = {};
    for (const field of PARTS_FIELDS) {
        const value = r[field];
        if (value !== null && value !== undefined && value !== '') populated[field] = value;
    }
    // Every column null means the description simply had no measurements;
    // returning an object of eleven nulls reads as a broken response instead.
    return Object.keys(populated).length > 0 ? populated : null;
}

/** True when any measurement was supplied at all. */
function hasAnyPartValue(parts) {
    return Object.values(parts || {}).some((v) => v !== null && v !== undefined && v !== '');
}

// ---------------------------------------------------------------------------
// Model class list (the scientificName join key)
// ---------------------------------------------------------------------------

const CLASSES_PATH = path.join(__dirname, '..', 'ml', 'model', 'main', 'classes.json');

let classesCache = null;

/**
 * Reads the trained model's class list, or null when it is not available yet.
 *
 * `ml/model/` does not exist until the model artifacts are downloaded, so every
 * caller must treat null as "cannot check", never as "no classes".
 */
function loadModelClasses() {
    if (classesCache !== null) return classesCache;
    try {
        if (!fs.existsSync(CLASSES_PATH)) return null;
        const parsed = JSON.parse(fs.readFileSync(CLASSES_PATH, 'utf8'));
        const values = Array.isArray(parsed) ? parsed : Object.values(parsed);
        classesCache = values
            .map((v) => (typeof v === 'string' ? { scientific: v, common: v } : v))
            .filter((v) => v && v.scientific)
            .map((v) => ({ scientific: v.scientific, common: v.common || v.scientific }));
        if (classesCache.length === 0) return null;
        return classesCache;
    } catch (err) {
        console.error('Could not read classes.json:', err.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Shared across approval, discovery and public reads
//
// These used to sit inside the sections that first needed them. They live here
// so approval-mysql.js, discovery-mysql.js and public-mysql.js can all use them
// without requiring one another in a circle.
// ---------------------------------------------------------------------------

const DISCOVERY_TYPE = 'plant_discovery';

/**
 * The two kinds of admin denial  `revise` is the default because every
 * existing Deny click sends it, and it must not silently become the harsher
 * option. Never free text: it is an action selector.
 */
const DENIAL_KINDS = ['revise', 'reject'];

function parsePayload(payload) {
    if (!payload) return {};
    if (typeof payload === 'string') {
        try {
            return JSON.parse(payload);
        } catch (err) {
            return {};
        }
    }
    return payload;
}

// ---------------------------------------------------------------------------
// Plant types. One row per plant: it carries that plant's name for its type, the
// medicinal / harmful flags, the toxicity level (the badge colour) and the
// caution note. Nothing here is shared between plants.
// ---------------------------------------------------------------------------

const typeFlag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

/**
 * Validates and tidies a plant's type fields. The name keeps the case it was
 * typed in (the names repeat across plants on purpose); a harmful plant must
 * state how toxic it is and a plant that is not harmful is stored as 'none'.
 * The caution note is always allowed: harmful or not.
 * Returns { errors, spec }.
 */
function normalizeTypeSpec(body) {
    const errors = [];
    const b = body && typeof body === 'object' ? body : {};
    const { nameMaxLength, cautionMaxLength, toxicityLevels } = settings.plantTypes;
    const typeName = String(b.typeName || '').trim().replace(/\s+/g, ' ');
    const cautionNote = normalizeRichText(b.cautionNote) || null;
    const isHarmful = typeFlag(b.isHarmful);
    const isMedicinal = typeFlag(b.isMedicinal);
    let toxicityLevel = 'none';

    if (!typeName) errors.push('typeName is required');
    else if (typeName.length > nameMaxLength) errors.push(`typeName is at most ${nameMaxLength} characters`);
    if (cautionNote && cautionNote.length > cautionMaxLength) {
        errors.push(`cautionNote is at most ${cautionMaxLength} characters`);
    }
    if (isHarmful) {
        toxicityLevel = String(b.toxicityLevel || '').toLowerCase();
        if (!toxicityLevels.includes(toxicityLevel) || toxicityLevel === 'none') {
            errors.push('Choose a toxicity level (mild, moderate or severe) for a harmful plant');
        }
    }
    return { errors, spec: { typeName, isMedicinal, isHarmful, toxicityLevel, cautionNote } };
}

/** "Herbal · medicinal · harmful (mild)" - how a type reads in a list or a diff. */
function describeType(t) {
    return t.typeName + (t.isMedicinal ? ' \u00b7 medicinal' : '') +
        (t.isHarmful ? ` \u00b7 harmful (${t.toxicityLevel})` : ' \u00b7 safe');
}

/** Inserts a type row for ONE plant and returns its typeId. Call inside a transaction. */
async function createPlantType(conn, spec) {
    return insertRow(
        conn, 'plant_types',
        ['typeName', 'isMedicinal', 'isHarmful', 'toxicityLevel', 'cautionNote'],
        [spec.typeName, spec.isMedicinal, spec.isHarmful, spec.toxicityLevel, spec.cautionNote]
    );
}

/** A private copy of an existing type row, for a plant that must not share it. */
async function cloneType(conn, typeId) {
    const [rows] = await conn.query(
        'SELECT typeName, isMedicinal, isHarmful, toxicityLevel, cautionNote FROM plant_types WHERE typeId = ?',
        [typeId]
    );
    if (rows.length === 0) return null;
    return createPlantType(conn, rows[0]);
}

module.exports = {
    normalizeRichText,
    normalizeTypeSpec,
    describeType,
    createPlantType,
    cloneType,
    parsePaging,
    escapeLike,
    normalizeName,
    normalizeScientificName,
    UNSPECIFIED_TAXONOMY,
    TAXONOMY_GAP_LEVELS,
    TAXONOMY_LEVELS,
    buildTaxonomyRow,
    PARTS_FIELDS,
    PARTS_SELECT,
    partsFromRow,
    hasAnyPartValue,
    loadModelClasses,
    DISCOVERY_TYPE,
    DENIAL_KINDS,
    parsePayload
};
