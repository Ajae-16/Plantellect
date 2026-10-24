// Change requests: a botanist asks for a correction to a plant that is already in
// the library, and an admin approves or denies it.
//
// A change request has TWO independent scopes, and each one is its own request
// row with its own reason and its own admin decision:
//
//   scope 'base'         the plant's shared record. One per plant at a time.
//       commonName, scientificName   plants
//       type.*                       the plant's OWN plant_types row: typeName,
//                                    isMedicinal, isHarmful, toxicityLevel, cautionNote
//       taxonomy.*                   the plant's OWN taxonomy row: kingdom, phylum,
//                                    class, order, family, genus, species
//
//   scope 'description'  ONE botanist's own description of the plant. A plant has
//       one plant_description row (plus its plant_parts row) per contribution, so
//       there is one request per description: uses, benefits, harmful and the
//       measurements (parts.*). payload.descriptionId says which one. A botanist
//       can only ask to change a description they wrote themselves.
//
// The two never write into each other. A base request cannot touch a description,
// a description request cannot touch the plant's record, and approving or denying
// one leaves the other exactly as it was. A botanist may file either, or both in
// one submit (which simply creates two requests).
//
// Entry points used from outside:
//   getPlantEditable(plantId, accountId)           GET  /api/plants/:plantId/editable
//   createPlantChangeRequest(accountId, id, body)  POST /api/plants/:plantId/changes
//   applyPlantChange(conn, request)                called by approvePlantRequest
//
// There is deliberately no separate "decide" function: approval and denial go
// through approvePlantRequest / denyPlantRequest like every other request type.
//
// Each change is stored with the value it was compared against ({ from, to }), and
// approval refuses a request whose `from` no longer matches (it has gone stale).
// Type changes also carry fromLabel / toLabel, which the diff views print.
//
// LEGACY: requests filed before the split carry no payload.scope and may mix base
// keys with the plant's primary description. applyPlantChange still honours them.

const { insertRow } = require('./ids.js');
const { mysqlPool } = require('./pool-mysql');
const {
    normalizeName, normalizeRichText, normalizeScientificName, loadModelClasses, parsePayload,
    PARTS_FIELDS, normalizeTypeSpec, TAXONOMY_LEVELS, UNSPECIFIED_TAXONOMY
} = require('./shared-mysql');

const NUMERIC_PARTS = ['heightMinCm', 'heightMaxCm', 'widthMinCm', 'widthMaxCm'];
const TEXT_LIMITS = { commonName: 255, scientificName: 255, uses: 5000, benefits: 5000, harmful: 5000 };
const PART_TEXT_LIMIT = 150;
const TAXONOMY_TEXT_LIMIT = 100;
const MAX_REASON = 500;
const DESCRIPTION_KEYS = ['uses', 'benefits', 'harmful'];
const TYPE_FIELDS = ['typeName', 'isMedicinal', 'isHarmful', 'toxicityLevel', 'cautionNote'];
const TYPE_KEYS = TYPE_FIELDS.map((f) => `type.${f}`);
const TAXONOMY_KEYS = TAXONOMY_LEVELS.map((l) => `taxonomy.${l}`);
const PARTS_KEYS = PARTS_FIELDS.map((f) => `parts.${f}`);

// Closed lists: `parts.` and `taxonomy.` keys become column names below.
const BASE_KEYS = ['commonName', 'scientificName', ...TYPE_KEYS, ...TAXONOMY_KEYS];
const DESCRIPTION_SCOPE_KEYS = [...DESCRIPTION_KEYS, ...PARTS_KEYS];
const ALLOWED_KEYS = [...BASE_KEYS, ...DESCRIPTION_SCOPE_KEYS];

const SCOPE_BASE = 'base';
const SCOPE_DESCRIPTION = 'description';

const isTypeKey = (key) => key.startsWith('type.');
const isTaxonomyKey = (key) => key.startsWith('taxonomy.');
const isPartsKey = (key) => key.startsWith('parts.');
const isBaseKey = (key) => BASE_KEYS.includes(key);
const isDescriptionKey = (key) => DESCRIPTION_SCOPE_KEYS.includes(key);

function isSafeType(type) {
    return Boolean(type) && !type.isHarmful && (type.toxicityLevel || 'none') === 'none';
}

/** A stored or typed value reduced to what is compared: null, a number, or tidy text. */
function norm(key, value) {
    if (key === 'type.isMedicinal' || key === 'type.isHarmful') {
        return value === true || Number(value) === 1 ? 1 : 0;
    }
    if (value === undefined || value === null || value === '') return null;
    if (isPartsKey(key) && NUMERIC_PARTS.includes(key.slice(6))) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    // Free text keeps its line breaks (richtext.js reads them), so compare it the same way.
    if (DESCRIPTION_KEYS.includes(key) || key === 'type.cautionNote') return normalizeRichText(value) || null;
    return normalizeName(value) || null;
}

/** What a type field reads as in a diff. */
function typeFieldLabel(field, value) {
    if (field === 'isMedicinal' || field === 'isHarmful') return value ? 'Yes' : 'No';
    if (field === 'toxicityLevel') return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'None';
    if (field === 'cautionNote') return value || '(none)';
    return value;
}

// ---------------------------------------------------------------------------
// Row loaders
// ---------------------------------------------------------------------------

/** The plant with its own type row and its own taxonomy row. */
async function loadPlantRecord(executor, plantId, lock) {
    const [rows] = await executor.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.typeId, p.taxonomyId,
                t.typeName, t.isMedicinal, t.isHarmful, t.toxicityLevel, t.cautionNote,
                tx.\`kingdom\`, tx.\`phylum\`, tx.\`class\`, tx.\`order\`, tx.\`family\`, tx.\`genus\`, tx.\`species\`
         FROM plants p
         JOIN plant_types t ON t.typeId = p.typeId
         JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
         WHERE p.plantId = ?${lock ? ' FOR UPDATE OF p, t, tx' : ''}`,
        [plantId]
    );
    return rows[0] || null;
}

const PART_COLUMNS = PARTS_FIELDS.map((f) => `pp.${f}`).join(', ');

/** One approved description with its measurements, by id. */
async function loadDescription(executor, plantId, descriptionId, lock) {
    const [rows] = await executor.query(
        `SELECT d.descriptionId, d.accountId, d.partsId, d.uses, d.benefits, d.harmful,
                d.isPrimary, d.createdAt, ${PART_COLUMNS}
         FROM plant_description d
         LEFT JOIN plant_parts pp ON pp.partId = d.partsId
         WHERE d.descriptionId = ? AND d.plantId = ? AND d.status = 'approved'${lock ? ' FOR UPDATE' : ''}`,
        [descriptionId, plantId]
    );
    return rows[0] || null;
}

/** The description the public page renders first. Only legacy requests use it. */
async function loadPrimaryDescription(executor, plantId, lock) {
    const [rows] = await executor.query(
        `SELECT d.descriptionId, d.accountId, d.partsId, d.uses, d.benefits, d.harmful, ${PART_COLUMNS}
         FROM plant_description d
         LEFT JOIN plant_parts pp ON pp.partId = d.partsId
         WHERE d.plantId = ? AND d.status = 'approved'
         ORDER BY d.isPrimary DESC, d.createdAt ASC
         LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
        [plantId]
    );
    return rows[0] || null;
}

/** Every approved description the account wrote for this plant, oldest first. */
async function loadOwnDescriptions(executor, plantId, accountId) {
    const [rows] = await executor.query(
        `SELECT d.descriptionId, d.accountId, d.partsId, d.uses, d.benefits, d.harmful,
                d.isPrimary, d.createdAt, ${PART_COLUMNS}
         FROM plant_description d
         LEFT JOIN plant_parts pp ON pp.partId = d.partsId
         WHERE d.plantId = ? AND d.accountId = ? AND d.status = 'approved'
         ORDER BY d.createdAt ASC`,
        [plantId, accountId]
    );
    return rows;
}

function currentSpec(plant) {
    return {
        typeName: plant.typeName,
        isMedicinal: plant.isMedicinal ? 1 : 0,
        isHarmful: plant.isHarmful ? 1 : 0,
        toxicityLevel: plant.toxicityLevel,
        cautionNote: plant.cautionNote || null
    };
}

/** Current value for a change key, from the rows loaded above. */
function currentValue(key, plant, desc) {
    if (isTypeKey(key)) return plant[key.slice(5)];
    if (isTaxonomyKey(key)) return plant[key.slice(9)];
    if (key === 'commonName' || key === 'scientificName') return plant[key];
    if (!desc) return null;
    if (isPartsKey(key)) return desc[key.slice(6)];
    return desc[key];
}

function descriptionValues(desc) {
    const values = {
        uses: desc.uses,
        benefits: desc.benefits,
        harmful: desc.harmful
    };
    for (const field of PARTS_FIELDS) {
        const raw = desc[field];
        // DECIMAL comes back as "12.50"; show 12.5 so an untouched field compares equal.
        values[`parts.${field}`] = raw === null || raw === undefined ? null
            : NUMERIC_PARTS.includes(field) ? Number(raw) : raw;
    }
    return values;
}

/** The pending change requests on a plant, read as { base, descriptions }. */
async function loadPendingChanges(executor, plantId) {
    const [rows] = await executor.query(
        `SELECT requestId, payload FROM approval_requests
         WHERE requestType = 'plant_change' AND targetPlantId = ? AND status = 'pending'`,
        [plantId]
    );
    const pending = { base: null, descriptions: new Map(), legacy: null };
    for (const row of rows) {
        const payload = parsePayload(row.payload);
        if (payload.scope === SCOPE_BASE) pending.base = pending.base || row.requestId;
        else if (payload.scope === SCOPE_DESCRIPTION && payload.descriptionId) {
            if (!pending.descriptions.has(payload.descriptionId)) {
                pending.descriptions.set(payload.descriptionId, row.requestId);
            }
        } else pending.legacy = pending.legacy || row.requestId;   // pre-split request: blocks both scopes
    }
    return pending;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Everything the "Request change" form needs for one plant and one botanist:
 *   base.*          the shared record (names, type, taxonomy) and whether a base
 *                   request is already waiting
 *   descriptions    ONLY the descriptions this botanist wrote, each with its own
 *                   values and its own pending flag
 * The keys of a description's `values` are exactly the keys of a change
 * (`parts.<field>` for measurements).
 */
async function getPlantEditable(plantId, accountId) {
    const plant = await loadPlantRecord(mysqlPool, plantId, false);
    if (!plant) return null;
    const own = await loadOwnDescriptions(mysqlPool, plantId, accountId);
    const pending = await loadPendingChanges(mysqlPool, plantId);

    const taxonomy = {};
    for (const level of TAXONOMY_LEVELS) taxonomy[level] = plant[level];

    const hasPendingBase = Boolean(pending.base || pending.legacy);
    return {
        id: plant.plantId,
        archived: false,   // ARCHIVE-OFF: plants.archivedAt does not exist yet
        isSafeType: isSafeType(plant),
        // Kept at the top level so the plant picker can label the chosen plant.
        values: { commonName: plant.commonName, scientificName: plant.scientificName },
        type: {
            typeName: plant.typeName,
            isMedicinal: Boolean(plant.isMedicinal),
            isHarmful: Boolean(plant.isHarmful),
            toxicityLevel: plant.toxicityLevel,
            cautionNote: plant.cautionNote || ''
        },
        taxonomy,
        hasPendingBase,
        pendingBaseRequestId: pending.base || pending.legacy || null,
        descriptions: own.map((d) => {
            const requestId = pending.descriptions.get(d.descriptionId) || pending.legacy || null;
            return {
                descriptionId: d.descriptionId,
                isPrimary: Boolean(d.isPrimary),
                createdAt: d.createdAt,
                hasPendingChange: Boolean(requestId),
                pendingRequestId: requestId,
                values: descriptionValues(d)
            };
        })
    };
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

function reasonOf(section) {
    return normalizeName(section && section.reason).slice(0, MAX_REASON);
}

/** Proposed base values out of the request body, validated. */
function collectBase(section, errors) {
    const asked = {};
    for (const key of ['commonName', 'scientificName']) {
        const raw = key === 'scientificName' ? normalizeScientificName(section[key]) : normalizeName(section[key]);
        if (!raw) continue;
        if (raw.length > TEXT_LIMITS[key]) {
            errors.push(`${key} is longer than ${TEXT_LIMITS[key]} characters`);
            continue;
        }
        asked[key] = raw;
    }

    const tax = section.taxonomy && typeof section.taxonomy === 'object' ? section.taxonomy : {};
    for (const level of TAXONOMY_LEVELS) {
        const value = normalizeName(level === 'class' ? (tax.class ?? tax.plantClass) : tax[level]);
        if (!value) continue;   // blank = no change
        if (value.length > TAXONOMY_TEXT_LIMIT) {
            errors.push(`${level} is longer than ${TAXONOMY_TEXT_LIMIT} characters`);
            continue;
        }
        if (value.toLowerCase() === UNSPECIFIED_TAXONOMY.toLowerCase()) {
            errors.push(`${level}: "${UNSPECIFIED_TAXONOMY}" marks a gap and cannot be proposed as a value`);
            continue;
        }
        asked[`taxonomy.${level}`] = value;
    }

    // The form sends the plant's WHOLE type (pre-filled), so a cleared caution
    // note is a real request to clear it, not "no change".
    let typeSpec = null;
    if (section.type && typeof section.type === 'object') {
        const t = normalizeTypeSpec(section.type);
        if (t.errors.length > 0) errors.push(`Plant type: ${t.errors.join('; ')}`);
        else typeSpec = t.spec;
    }
    return { asked, typeSpec };
}

/** Proposed description values out of the request body, validated. */
function collectDescription(section, errors) {
    const asked = {};
    for (const key of DESCRIPTION_KEYS) {
        const raw = normalizeRichText(section[key]);
        if (!raw) continue;
        if (raw.length > TEXT_LIMITS[key]) {
            errors.push(`${key} is longer than ${TEXT_LIMITS[key]} characters`);
            continue;
        }
        asked[key] = raw;
    }
    const parts = section.parts && typeof section.parts === 'object' ? section.parts : {};
    for (const field of PARTS_FIELDS) {
        const raw = parts[field];
        if (raw === undefined || raw === null || String(raw).trim() === '') continue;
        if (NUMERIC_PARTS.includes(field)) {
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0 || n > 9999.99) {
                errors.push(`${field} must be a number from 0 to 9999.99`);
                continue;
            }
            asked[`parts.${field}`] = n;
        } else {
            const text = normalizeName(raw);
            if (text.length > PART_TEXT_LIMIT) {
                errors.push(`${field} is longer than ${PART_TEXT_LIMIT} characters`);
                continue;
            }
            asked[`parts.${field}`] = text;
        }
    }
    return asked;
}

function failure(error, code) {
    return { error, code };
}

/**
 * Files a change request. The body names the scopes the botanist chose:
 *   { base: { reason, commonName?, scientificName?, taxonomy?, type? },
 *     description: { descriptionId, reason, uses?, benefits?, harmful?, parts? } }
 * A scope that is absent is not requested and stays untouched. Each scope that is
 * present becomes its own pending request, with its own reason. Never
 * auto-approved: change requests have no approval switch, so an admin decides.
 * One pending base request per plant, one pending request per description.
 */
async function createPlantChangeRequest(accountId, plantId, body) {
    const b = body && typeof body === 'object' ? body : {};
    const baseSection = b.base && typeof b.base === 'object' ? b.base : null;
    const descSection = b.description && typeof b.description === 'object' ? b.description : null;
    if (!baseSection && !descSection) {
        return failure('Choose what to change: the plant info, your own description, or both', 400);
    }

    const baseReason = baseSection ? reasonOf(baseSection) : '';
    const descReason = descSection ? reasonOf(descSection) : '';
    if (baseSection && !baseReason) {
        return failure('Say why the plant info needs changing, so the admin can judge it', 400);
    }
    if (descSection && !descReason) {
        return failure('Say why your description needs changing, so the admin can judge it', 400);
    }

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        // Locking the plant row serialises two botanists filing at once, so the
        // pending checks below cannot be raced.
        const plant = await loadPlantRecord(conn, plantId, true);
        if (!plant) {
            await conn.rollback();
            return failure('Plant not found', 404);
        }
        const pending = await loadPendingChanges(conn, plantId);

        const filed = [];   // [{ scope, changes, payload }]
        const errors = [];

        // ---------------- base ----------------
        if (baseSection) {
            const { asked, typeSpec } = collectBase(baseSection, errors);
            if (errors.length > 0) {
                await conn.rollback();
                return failure(errors.join('; '), 400);
            }

            const changes = {};
            for (const [key, to] of Object.entries(asked)) {
                const from = norm(key, currentValue(key, plant, null));
                if (from !== to) changes[key] = { from, to };
            }
            if (typeSpec) {
                const current = currentSpec(plant);
                for (const field of TYPE_FIELDS) {
                    const key = `type.${field}`;
                    const from = norm(key, current[field]);
                    const to = norm(key, typeSpec[field]);
                    if (from !== to) {
                        changes[key] = {
                            from, to,
                            fromLabel: typeFieldLabel(field, current[field]),
                            toLabel: typeFieldLabel(field, typeSpec[field])
                        };
                    }
                }
            }
            if (Object.keys(changes).length === 0) {
                await conn.rollback();
                return failure('Plant info: that is what the plant already records, so there is nothing to change', 400);
            }

            if (changes.scientificName) {
                const classes = loadModelClasses();
                if (classes) {
                    const match = classes.find((c) => c.scientific.toLowerCase() === changes.scientificName.to.toLowerCase());
                    if (match) changes.scientificName.to = match.scientific;
                }
                const [clash] = await conn.query(
                    'SELECT plantId, commonName FROM plants WHERE scientificName = ? AND plantId <> ?',
                    [changes.scientificName.to, plantId]
                );
                if (clash.length > 0) {
                    await conn.rollback();
                    return failure(`"${changes.scientificName.to}" is already in the library as ${clash[0].commonName}.`, 409);
                }
            }

            const waiting = pending.base || pending.legacy;
            if (waiting) {
                await conn.rollback();
                return failure(`A change to this plant's info is already waiting for review (${waiting}).`, 409);
            }
            filed.push({ scope: SCOPE_BASE, changes, payload: { scope: SCOPE_BASE, changes, reason: baseReason } });
        }

        // ---------------- description ----------------
        if (descSection) {
            const descriptionId = String(descSection.descriptionId || '').trim();
            if (!descriptionId) {
                await conn.rollback();
                return failure('Choose which of your descriptions to change', 400);
            }
            // Own descriptions only, and only approved ones: the row is the
            // uploader's, so nobody else's request can rewrite it.
            const desc = await loadDescription(conn, plantId, descriptionId, false);
            if (!desc || desc.accountId !== accountId) {
                await conn.rollback();
                return failure('That description is not one of yours, or it is not approved yet', 403);
            }

            const asked = collectDescription(descSection, errors);
            if (errors.length > 0) {
                await conn.rollback();
                return failure(errors.join('; '), 400);
            }
            const changes = {};
            for (const [key, to] of Object.entries(asked)) {
                const from = norm(key, currentValue(key, plant, desc));
                if (from !== to) changes[key] = { from, to };
            }
            if (Object.keys(changes).length === 0) {
                await conn.rollback();
                return failure('Your description: that is what it already records, so there is nothing to change', 400);
            }
            if (changes.harmful && isSafeType(plant)) {
                await conn.rollback();
                return failure('This plant is marked safe, so there is no harmful text to record', 400);
            }
            for (const [lo, hi] of [['heightMinCm', 'heightMaxCm'], ['widthMinCm', 'widthMaxCm']]) {
                const pick = (f) => (changes[`parts.${f}`] ? changes[`parts.${f}`].to : norm(`parts.${f}`, desc[f]));
                const min = pick(lo);
                const max = pick(hi);
                if (min !== null && max !== null && min > max) {
                    await conn.rollback();
                    return failure(`${lo} cannot exceed ${hi}`, 400);
                }
            }

            const waiting = pending.descriptions.get(descriptionId) || pending.legacy;
            if (waiting) {
                await conn.rollback();
                return failure(`A change to that description is already waiting for review (${waiting}).`, 409);
            }
            filed.push({
                scope: SCOPE_DESCRIPTION,
                changes,
                payload: { scope: SCOPE_DESCRIPTION, descriptionId, changes, reason: descReason }
            });
        }

        const requests = [];
        for (const item of filed) {
            const requestId = await insertRow(
                conn, 'approval_requests',
                ['accountId', 'requestType', 'targetPlantId', 'payload', 'status'],
                [accountId, 'plant_change', plantId, JSON.stringify(item.payload), 'pending']
            );
            requests.push({ requestId, scope: item.scope, changes: item.changes });
        }
        await conn.commit();
        return { requests, requestId: requests[0].requestId };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// Applying an approved change
// ---------------------------------------------------------------------------

/**
 * Applies a plant_change inside the caller's transaction. The request has already
 * been claimed as pending. Returns { plantId, applied, scope } or { error, code }.
 *
 * A request writes only inside its own scope: a base request refuses any
 * description key and a description request refuses any base key, so a
 * hand-made payload cannot reach across and edit the other side.
 */
async function applyPlantChange(conn, request) {
    const payload = parsePayload(request.payload);
    const changes = payload.changes && typeof payload.changes === 'object' ? payload.changes : {};
    const scope = payload.scope === SCOPE_BASE || payload.scope === SCOPE_DESCRIPTION ? payload.scope : null;   // null = legacy
    const keys = Object.keys(changes).filter((k) => ALLOWED_KEYS.includes(k));
    if (!request.targetPlantId || keys.length === 0) {
        return { error: 'This change request has no plant or no changes to apply', code: 400 };
    }
    if (scope === SCOPE_BASE && !keys.every(isBaseKey)) {
        return { error: 'A plant-info request cannot change a description', code: 400 };
    }
    if (scope === SCOPE_DESCRIPTION && !keys.every(isDescriptionKey)) {
        return { error: 'A description request cannot change the plant info', code: 400 };
    }

    const plant = await loadPlantRecord(conn, request.targetPlantId, true);
    if (!plant) return { error: 'The plant no longer exists', code: 404 };

    const baseKeys = keys.filter(isBaseKey);
    const descKeys = keys.filter(isDescriptionKey);

    let desc = null;
    if (descKeys.length > 0) {
        if (scope === SCOPE_DESCRIPTION) {
            desc = await loadDescription(conn, request.targetPlantId, payload.descriptionId, true);
            if (!desc) return { error: 'That description no longer exists or is no longer approved', code: 409 };
            if (desc.accountId !== request.accountId) {
                return { error: 'That description does not belong to the person who filed this request', code: 409 };
            }
        } else {
            desc = await loadPrimaryDescription(conn, request.targetPlantId, true);   // legacy
            if (!desc) return { error: 'The plant has no approved description to correct', code: 409 };
        }
    }

    // Stale check: the row must still hold what the botanist saw.
    for (const key of keys) {
        if (norm(key, currentValue(key, plant, desc)) !== norm(key, changes[key].from)) {
            return {
                error: `${key} changed since this was filed. Deny it and ask for a fresh request.`,
                code: 409
            };
        }
    }

    // ---- plants ----
    const plantSets = [];
    const plantParams = [];
    for (const key of ['commonName', 'scientificName']) {
        if (!changes[key] || !baseKeys.includes(key)) continue;
        const value = key === 'scientificName' ? normalizeScientificName(changes[key].to) : normalizeName(changes[key].to);
        if (!value) return { error: `${key} cannot be empty`, code: 400 };
        plantSets.push(`${key} = ?`);
        plantParams.push(value);
    }
    if (plantSets.length > 0) {
        try {
            await conn.query(`UPDATE plants SET ${plantSets.join(', ')} WHERE plantId = ?`, [...plantParams, plant.plantId]);
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return { error: 'That scientific name was taken by another plant since this was filed', code: 409 };
            }
            throw err;
        }
    }

    // ---- the plant's own type row ----
    // The merged result is validated as a whole (a harmful plant needs a level) and
    // all five columns are written together, so a hand-made payload cannot leave
    // isHarmful and toxicityLevel disagreeing.
    let effectiveType = plant;
    const typeKeys = baseKeys.filter(isTypeKey);
    if (typeKeys.length > 0) {
        const merged = currentSpec(plant);
        for (const key of typeKeys) merged[key.slice(5)] = changes[key].to;
        const t = normalizeTypeSpec(merged);
        if (t.errors.length > 0) return { error: `Plant type: ${t.errors.join('; ')}`, code: 400 };
        await conn.query(
            `UPDATE plant_types
             SET typeName = ?, isMedicinal = ?, isHarmful = ?, toxicityLevel = ?, cautionNote = ?
             WHERE typeId = ?`,
            [t.spec.typeName, t.spec.isMedicinal, t.spec.isHarmful, t.spec.toxicityLevel, t.spec.cautionNote, plant.typeId]
        );
        effectiveType = t.spec;
    }

    // ---- the plant's own taxonomy row ----
    const taxonomyKeys = baseKeys.filter(isTaxonomyKey);
    if (taxonomyKeys.length > 0) {
        const levels = taxonomyKeys.map((k) => k.slice(9));   // members of TAXONOMY_LEVELS (closed list above)
        for (const level of levels) {
            const value = normalizeName(changes[`taxonomy.${level}`].to);
            if (!value || value.toLowerCase() === UNSPECIFIED_TAXONOMY.toLowerCase()) {
                return { error: `taxonomy ${level} cannot be empty or "${UNSPECIFIED_TAXONOMY}"`, code: 400 };
            }
        }
        const assignments = levels.map((level) => `\`${level}\` = ?`).join(', ');
        await conn.query(
            `UPDATE taxonomy SET ${assignments} WHERE taxonomyId = ?`,
            [...levels.map((level) => normalizeName(changes[`taxonomy.${level}`].to)), plant.taxonomyId]
        );
    }

    if (changes.harmful && descKeys.includes('harmful') && isSafeType(effectiveType)) {
        return { error: 'The plant is marked safe, so harmful text cannot be recorded', code: 400 };
    }

    // ---- the description text ----
    const textKeys = descKeys.filter((k) => DESCRIPTION_KEYS.includes(k));
    const partKeys = descKeys.filter(isPartsKey);
    if (textKeys.length > 0) {
        const sets = textKeys.map((k) => `${k} = ?`).join(', ');   // keys come from DESCRIPTION_KEYS
        await conn.query(
            `UPDATE plant_description SET ${sets} WHERE descriptionId = ?`,
            [...textKeys.map((k) => normalizeRichText(changes[k].to)), desc.descriptionId]
        );
    }

    // ---- that description's measurements ----
    if (partKeys.length > 0) {
        const cols = partKeys.map((k) => k.slice(6));
        const values = cols.map((c) => (NUMERIC_PARTS.includes(c) ? Number(changes[`parts.${c}`].to) : normalizeName(changes[`parts.${c}`].to)));
        if (desc.partsId) {
            const sets = cols.map((c) => `${c} = ?`).join(', ');   // cols are PARTS_FIELDS members
            await conn.query(`UPDATE plant_parts SET ${sets} WHERE partId = ?`, [...values, desc.partsId]);
        } else {
            // A text-only description has no measurements row yet; make one.
            const partsId = await insertRow(
                conn, 'plant_parts',
                ['plantId', 'accountId', ...cols, 'status'],
                [plant.plantId, desc.accountId, ...values, 'approved']
            );
            await conn.query('UPDATE plant_description SET partsId = ? WHERE descriptionId = ?', [partsId, desc.descriptionId]);
        }
    }

    return { plantId: plant.plantId, applied: keys, scope: scope || 'legacy' };
}

module.exports = {
    getPlantEditable,
    createPlantChangeRequest,
    applyPlantChange,
    ALLOWED_KEYS
};
