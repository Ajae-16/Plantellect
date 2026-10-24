// Admin: edit a plant directly (no request, no review: the admin IS the reviewer).
//
// Two independent things, mirroring the change-request split (plant-manage-mysql.js):
//   base         commonName, scientificName, the plant's own type row and its taxonomy row
//   description  ONE botanist's description (uses / benefits / harmful) and that botanist's
//                measurements (plant_parts), chosen by descriptionId
// plus "make this description the primary one": the primary description is the one the plant
// page shows first and the library card reads from. Exactly one description per plant is primary.
//
// Saving the base never touches a description and saving a description never touches the base.
// Free text keeps its line breaks and formatting marks (normalizeRichText).

const { insertRow } = require('./ids.js');
const { mysqlPool } = require('./pool-mysql');
const {
    normalizeName, normalizeRichText, normalizeScientificName, normalizeTypeSpec,
    PARTS_FIELDS, TAXONOMY_LEVELS
} = require('./shared-mysql');

const NUMERIC_PARTS = ['heightMinCm', 'heightMaxCm', 'widthMinCm', 'widthMaxCm'];
const TEXT_LIMITS = { commonName: 255, scientificName: 255, uses: 5000, benefits: 5000, harmful: 5000 };
const PART_TEXT_LIMIT = 150;
const TAXONOMY_TEXT_LIMIT = 100;
const DESCRIPTION_KEYS = ['uses', 'benefits', 'harmful'];

const fail = (error, code = 400) => ({ error, code });

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The base record plus EVERY approved description with its author, primary first. */
async function getAdminPlantEdit(plantId) {
    const [plants] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName,
                t.typeName, t.isMedicinal, t.isHarmful, t.toxicityLevel, t.cautionNote,
                tx.\`kingdom\`, tx.\`phylum\`, tx.\`class\`, tx.\`order\`, tx.\`family\`, tx.\`genus\`, tx.\`species\`
         FROM plants p
         JOIN plant_types t ON t.typeId = p.typeId
         LEFT JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
         WHERE p.plantId = ?`,
        [plantId]
    );
    if (plants.length === 0) return null;
    const p = plants[0];

    const partColumns = PARTS_FIELDS.map((f) => `pp.${f}`).join(', ');
    const [rows] = await mysqlPool.query(
        `SELECT d.descriptionId, d.accountId, d.uses, d.benefits, d.harmful, d.isPrimary, d.createdAt,
                COALESCE(NULLIF(TRIM(CONCAT_WS(' ', pr.firstName, pr.lastName)), ''), a.username) AS authorName,
                ${partColumns}
         FROM plant_description d
         JOIN accounts a ON a.accountId = d.accountId
         LEFT JOIN profiles pr ON pr.accountId = d.accountId
         LEFT JOIN plant_parts pp ON pp.partId = d.partsId
         WHERE d.plantId = ? AND d.status = 'approved'
         ORDER BY d.isPrimary DESC, d.createdAt ASC`,
        [plantId]
    );

    const taxonomy = {};
    for (const level of TAXONOMY_LEVELS) taxonomy[level] = p[level] == null ? '' : p[level];

    return {
        id: p.plantId,
        base: {
            commonName: p.commonName,
            scientificName: p.scientificName,
            type: {
                typeName: p.typeName,
                isMedicinal: Boolean(p.isMedicinal),
                isHarmful: Boolean(p.isHarmful),
                toxicityLevel: p.toxicityLevel,
                cautionNote: p.cautionNote || ''
            },
            taxonomy
        },
        descriptions: rows.map((r) => {
            const parts = {};
            for (const f of PARTS_FIELDS) parts[f] = r[f] == null ? null : (NUMERIC_PARTS.includes(f) ? Number(r[f]) : r[f]);
            return {
                descriptionId: r.descriptionId,
                accountId: r.accountId,
                authorName: r.authorName,
                isPrimary: Boolean(r.isPrimary),
                createdAt: r.createdAt,
                uses: r.uses || '',
                benefits: r.benefits || '',
                harmful: r.harmful || '',
                parts
            };
        })
    };
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

async function updatePlantBase(plantId, body) {
    const b = body && typeof body === 'object' ? body : {};
    const errors = [];

    const commonName = normalizeName(b.commonName);
    const scientificName = normalizeScientificName(b.scientificName);
    if (!commonName) errors.push('Common name cannot be blank');
    if (!scientificName) errors.push('Scientific name cannot be blank');
    if (commonName.length > TEXT_LIMITS.commonName) errors.push(`Common name is longer than ${TEXT_LIMITS.commonName} characters`);
    if (scientificName.length > TEXT_LIMITS.scientificName) errors.push(`Scientific name is longer than ${TEXT_LIMITS.scientificName} characters`);

    let typeSpec = null;
    if (b.type && typeof b.type === 'object') {
        const t = normalizeTypeSpec(b.type);
        if (t.errors.length) errors.push(...t.errors);
        else typeSpec = t.spec;
    }

    const taxonomy = {};
    const rawTax = b.taxonomy && typeof b.taxonomy === 'object' ? b.taxonomy : {};
    for (const level of TAXONOMY_LEVELS) {
        const value = normalizeName(level === 'class' ? (rawTax.class ?? rawTax.plantClass) : rawTax[level]);
        if (!value) continue;   // blank = leave as it is
        if (value.length > TAXONOMY_TEXT_LIMIT) errors.push(`${level} is longer than ${TAXONOMY_TEXT_LIMIT} characters`);
        else taxonomy[level] = value;
    }
    if (errors.length) return fail(errors.join('; '));

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            'SELECT plantId, typeId, taxonomyId FROM plants WHERE plantId = ? FOR UPDATE',
            [plantId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return fail('Plant not found', 404);
        }
        const plant = rows[0];

        await conn.query(
            'UPDATE plants SET commonName = ?, scientificName = ? WHERE plantId = ?',
            [commonName, scientificName, plantId]
        );
        if (typeSpec) {
            await conn.query(
                `UPDATE plant_types
                 SET typeName = ?, isMedicinal = ?, isHarmful = ?, toxicityLevel = ?, cautionNote = ?
                 WHERE typeId = ?`,
                [typeSpec.typeName, typeSpec.isMedicinal, typeSpec.isHarmful, typeSpec.toxicityLevel, typeSpec.cautionNote, plant.typeId]
            );
        }
        const levels = Object.keys(taxonomy);
        if (levels.length) {
            // levels come from TAXONOMY_LEVELS, a closed list, so they are safe as column names.
            await conn.query(
                `UPDATE taxonomy SET ${levels.map((l) => `\`${l}\` = ?`).join(', ')} WHERE taxonomyId = ?`,
                [...levels.map((l) => taxonomy[l]), plant.taxonomyId]
            );
        }
        await conn.commit();
        return { plantId };
    } catch (err) {
        await conn.rollback().catch(() => {});
        if (err && err.code === 'ER_DUP_ENTRY') {
            return fail('Another plant already uses that scientific name', 409);
        }
        throw err;
    } finally {
        conn.release();
    }
}

// ---------------------------------------------------------------------------
// One description
// ---------------------------------------------------------------------------

async function updateDescription(plantId, descriptionId, body) {
    const b = body && typeof body === 'object' ? body : {};
    const errors = [];

    const text = {};
    for (const key of DESCRIPTION_KEYS) {
        const value = normalizeRichText(b[key]);
        if (value.length > TEXT_LIMITS[key]) errors.push(`${key} is longer than ${TEXT_LIMITS[key]} characters`);
        text[key] = value || null;   // blank clears it
    }

    const parts = {};
    const rawParts = b.parts && typeof b.parts === 'object' ? b.parts : {};
    for (const field of PARTS_FIELDS) {
        const raw = rawParts[field];
        if (raw === undefined) continue;   // not sent = leave alone
        if (raw === null || String(raw).trim() === '') { parts[field] = null; continue; }
        if (NUMERIC_PARTS.includes(field)) {
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0 || n > 9999.99) errors.push(`${field} must be a number from 0 to 9999.99`);
            else parts[field] = n;
        } else {
            const value = normalizeName(raw);
            if (value.length > PART_TEXT_LIMIT) errors.push(`${field} is longer than ${PART_TEXT_LIMIT} characters`);
            else parts[field] = value;
        }
    }
    if (errors.length) return fail(errors.join('; '));

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT d.descriptionId, d.accountId, d.partsId, t.isHarmful, t.toxicityLevel
             FROM plant_description d
             JOIN plants p ON p.plantId = d.plantId
             JOIN plant_types t ON t.typeId = p.typeId
             WHERE d.descriptionId = ? AND d.plantId = ? AND d.status = 'approved' FOR UPDATE`,
            [descriptionId, plantId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return fail('Description not found on this plant', 404);
        }
        const desc = rows[0];
        const safe = !desc.isHarmful && (desc.toxicityLevel || 'none') === 'none';
        if (text.harmful && safe) {
            await conn.rollback();
            return fail('The plant is marked safe, so harmful text cannot be recorded. Change the plant type first.');
        }

        // Existing measurements, merged with what was sent, to validate min <= max and to
        // decide whether anything is left at all.
        let current = {};
        if (desc.partsId) {
            const [pr] = await conn.query('SELECT * FROM plant_parts WHERE partId = ? FOR UPDATE', [desc.partsId]);
            current = pr[0] || {};
        }
        const merged = {};
        for (const f of PARTS_FIELDS) merged[f] = f in parts ? parts[f] : (current[f] == null ? null : current[f]);
        if (merged.heightMinCm != null && merged.heightMaxCm != null && Number(merged.heightMinCm) > Number(merged.heightMaxCm)) {
            await conn.rollback();
            return fail('Height min cannot exceed height max');
        }
        if (merged.widthMinCm != null && merged.widthMaxCm != null && Number(merged.widthMinCm) > Number(merged.widthMaxCm)) {
            await conn.rollback();
            return fail('Width min cannot exceed width max');
        }
        const hasParts = PARTS_FIELDS.some((f) => merged[f] !== null && merged[f] !== '');
        if (!text.uses && !text.benefits && !text.harmful && !hasParts) {
            await conn.rollback();
            return fail('A description needs some text or measurements');
        }

        await conn.query(
            'UPDATE plant_description SET uses = ?, benefits = ?, harmful = ? WHERE descriptionId = ?',
            [text.uses, text.benefits, text.harmful, descriptionId]
        );

        const sent = Object.keys(parts);
        if (sent.length) {
            if (desc.partsId) {
                // sent keys are PARTS_FIELDS members, a closed list.
                await conn.query(
                    `UPDATE plant_parts SET ${sent.map((f) => `${f} = ?`).join(', ')} WHERE partId = ?`,
                    [...sent.map((f) => parts[f]), desc.partsId]
                );
            } else if (hasParts) {
                const partsId = await insertRow(
                    conn, 'plant_parts',
                    ['plantId', 'accountId', ...sent, 'status'],
                    [plantId, desc.accountId, ...sent.map((f) => parts[f]), 'approved']
                );
                await conn.query('UPDATE plant_description SET partsId = ? WHERE descriptionId = ?', [partsId, descriptionId]);
            }
        }

        if (b.makePrimary === true || b.makePrimary === 'true') {
            await conn.query('UPDATE plant_description SET isPrimary = FALSE WHERE plantId = ?', [plantId]);
            await conn.query('UPDATE plant_description SET isPrimary = TRUE WHERE descriptionId = ?', [descriptionId]);
        }

        await conn.commit();
        return { plantId, descriptionId };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

/** Makes one approved description the primary one. The previous primary stays, as another box. */
async function setPrimaryDescription(plantId, descriptionId) {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT descriptionId FROM plant_description
             WHERE descriptionId = ? AND plantId = ? AND status = 'approved' FOR UPDATE`,
            [descriptionId, plantId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return fail('Description not found on this plant', 404);
        }
        await conn.query('UPDATE plant_description SET isPrimary = FALSE WHERE plantId = ?', [plantId]);
        await conn.query('UPDATE plant_description SET isPrimary = TRUE WHERE descriptionId = ?', [descriptionId]);
        await conn.commit();
        return { plantId, descriptionId };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = { getAdminPlantEdit, updatePlantBase, updateDescription, setPrimaryDescription };
