// Helpers, normalisation, taxonomy, plant_parts column set and model class list shared by the other mysql modules.
// Split out of mysql.js; see mysql.js for the combined export list.

const path = require('path');
const fs = require('fs');
const settings = require('./settings');

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

module.exports = {
    parsePaging,
    escapeLike,
    normalizeName,
    normalizeScientificName,
    UNSPECIFIED_TAXONOMY,
    TAXONOMY_GAP_LEVELS,
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
