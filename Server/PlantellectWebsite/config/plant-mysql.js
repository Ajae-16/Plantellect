// Admin: plants.
// Split out of mysql.js; see mysql.js for the combined export list.

const { mysqlPool } = require('./pool-mysql');
const { parsePaging, escapeLike, TAXONOMY_GAP_LEVELS, UNSPECIFIED_TAXONOMY, PARTS_SELECT, partsFromRow } = require('./shared-mysql');

// ---------------------------------------------------------------------------
// Admin: plants
// ---------------------------------------------------------------------------

const CONTRIBUTOR_LIST_LENGTH = 120;

/**
 * Paginated plant inventory. Recorded By and Reviewed By are GROUP_CONCATs of
 * plant_contributors, truncated so one busy plant cannot blow up the payload.
 *
 * Also reports which taxonomy levels are still Unspecified, because that is the
 * whole value of the left join on taxonomy: nothing else in the project reads
 * those columns, so a gap would otherwise be invisible.
 */
async function listPlants({ search, type, taxonomyGap, page, pageSize }) {
    const paging = parsePaging({ page, pageSize });
    const where = [];
    const params = [];

    if (search) {
        where.push("(p.commonName LIKE ? ESCAPE '\\\\' OR p.scientificName LIKE ? ESCAPE '\\\\')");
        const like = `%${escapeLike(search)}%`;
        params.push(like, like);
    }
    if (type) {
        where.push('t.typeName = ?');
        params.push(type);
    }

    const GAP_PREDICATE = TAXONOMY_GAP_LEVELS
        .map((level) => `tx.\`${level}\` = '${UNSPECIFIED_TAXONOMY}'`)
        .join(' OR ');
    if (taxonomyGap) where.push(`(${GAP_PREDICATE})`);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const gapSelect = TAXONOMY_GAP_LEVELS.map((level) => `tx.\`${level}\` AS tax_${level}`).join(', ');

    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.quantity, p.createdAt,
                t.typeName, t.label AS typeLabel, t.icon AS typeIcon, t.badgeClass AS typeBadgeClass,
                ${gapSelect},
                (SELECT COUNT(*) FROM plant_images i WHERE i.plantId = p.plantId AND i.status = 'approved') AS imageCount,
                (SELECT COUNT(*) FROM plant_images i WHERE i.plantId = p.plantId AND i.status = 'pending') AS pendingImageCount,
                (SELECT COUNT(*) FROM plant_description d WHERE d.plantId = p.plantId AND d.status = 'approved') AS descriptionCount
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         LEFT JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
         ${whereSql}
         ORDER BY p.createdAt DESC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );

    // Must carry the same FROM as the row query above: whereSql can reference
    // the taxonomy alias when ?taxonomyGap=1 is set, and a count without the join
    // cannot resolve it.
    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         LEFT JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
         ${whereSql}`,
        params
    );

    // Read from the same response rather than a second endpoint: the dashboard
    // card and this table can then never disagree.
    const [gapCountRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         LEFT JOIN taxonomy tx ON tx.taxonomyId = p.taxonomyId
         WHERE (${GAP_PREDICATE})`
    );

    const plants = [];
    for (const row of rows) {
        plants.push({
            id: row.plantId,
            name: row.commonName,
            scientificName: row.scientificName,
            type: row.typeName,
            typeLabel: row.typeLabel,
            typeIcon: row.typeIcon,
            typeBadgeClass: row.typeBadgeClass,
            quantity: row.quantity,
            dateUploaded: row.createdAt,
            imageCount: row.imageCount,
            pendingImageCount: row.pendingImageCount,
            descriptionCount: row.descriptionCount,
            missingTaxonomyLevels: TAXONOMY_GAP_LEVELS.filter(
                (level) => row[`tax_${level}`] === UNSPECIFIED_TAXONOMY
            ),
            ...(await getContributorSummary(row.plantId)),
            ...(await getPlantDetailSummary(row.plantId))
        });
    }

    return {
        plants,
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize,
        taxonomyGapTotal: gapCountRows[0].total,
        taxonomyGapLevels: TAXONOMY_GAP_LEVELS
    };
}

/**
 * Who is named on a plant, and for what.
 *
 * Three roles now reach this: 'contributor' renders as Recorded By, 'reviewer'
 * as Reviewed By, and 'reporter' as Reported By — the account that filed the
 * discovery report which produced the species. Reported By is CREDIT, not
 * authorship: a `user` never appears as a contributor and never authors a
 * plant_description.
 */
/**
 * The contributor labels a plant page renders.
 *
 * The label is the profile name when there is one, and the username otherwise.
 * `CONCAT_WS` rather than `CONCAT` because `CONCAT` with a NULL lastName yields
 * NULL for the WHOLE string, which silently discards a first name the account did
 * give — and the machine actor is exactly that case (firstName 'System', lastName
 * NULL), which would have left "Reviewed By" empty on every automatically approved
 * plant. TRIM because CONCAT_WS of a first name and a NULL still leaves nothing to
 * trim, but a profile with an empty-string last name would.
 *
 * The COALESCE back to the username is NOT new and must not be dropped: many
 * accounts have no profile row at all, and without the fallback every one of them
 * would vanish from Recorded By / Reviewed By / Reported By.
 */
async function getContributorSummary(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT pc.role, GROUP_CONCAT(DISTINCT COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.firstName, p.lastName)), ''), a.username)
                    ORDER BY pc.createdAt SEPARATOR ', ') AS names
         FROM plant_contributors pc
         JOIN accounts a ON pc.accountId = a.accountId
         LEFT JOIN profiles p ON p.accountId = a.accountId
         WHERE pc.plantId = ?
         GROUP BY pc.role`,
        [plantId]
    );
    const summary = { recordedBy: [], reviewedBy: [], reportedBy: [] };
    for (const row of rows) {
        const names = row.names || '';
        if (!names) continue;
        const parts = names.split(', ');
        const shown = parts.slice(0, 3).join(', ');
        const overflow = parts.length > 3 ? ` +${parts.length - 3} more` : '';
        const label = (shown + overflow).slice(0, CONTRIBUTOR_LIST_LENGTH);
        if (row.role === 'contributor') summary.recordedBy.push(label);
        if (row.role === 'reviewer') summary.reviewedBy.push(label);
        if (row.role === 'reporter') summary.reportedBy.push(label);
    }
    return {
        recordedBy: summary.recordedBy.join('; '),
        reviewedBy: summary.reviewedBy.join('; '),
        reportedBy: summary.reportedBy.join('; ')
    };
}

async function getPlantDetailSummary(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT d.uses, d.benefits, d.harmful,
                ${PARTS_SELECT}
         FROM plant_description d
         -- LEFT JOIN, not INNER: partsId is nullable, so a description recorded
         -- without measurements is still a description.
         LEFT JOIN plant_parts pp ON d.partsId = pp.partId
         WHERE d.plantId = ? AND d.status = 'approved' AND d.isPrimary = TRUE
         LIMIT 1`,
        [plantId]
    );
    if (rows.length === 0) return { parts: null, description: null };
    const r = rows[0];
    return {
        parts: partsFromRow(r),
        description: { uses: r.uses, benefits: r.benefits, harmful: r.harmful }
    };
}

async function listPlantImages(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT i.imageId, i.originalFilename, i.mimeType, i.size, i.status, i.isPrimary, i.uploadedAt,
                a.username AS uploadedByName
         FROM plant_images i
         JOIN accounts a ON i.accountId = a.accountId
         WHERE i.plantId = ?
         ORDER BY i.isPrimary DESC, i.uploadedAt ASC`,
        [plantId]
    );
    return rows.map((r) => ({
        imageId: r.imageId,
        originalFilename: r.originalFilename,
        mimeType: r.mimeType,
        size: r.size,
        status: r.status,
        isPrimary: Boolean(r.isPrimary),
        uploadedAt: r.uploadedAt,
        uploadedByName: r.uploadedByName
    }));
}

/** Public serving: approved rows only. */
async function getImageForServing(imageId) {
    const [rows] = await mysqlPool.query(
        `SELECT imageId, plantId, originalFilename, storedPath, mimeType
         FROM plant_images WHERE imageId = ? AND status = 'approved'`,
        [imageId]
    );
    return rows[0] || null;
}

/**
 * Review-time serving: any status, because an admin has to see the photos they
 * are being asked to approve. Never reachable from a public route.
 */
async function getImageForReview(imageId) {
    const [rows] = await mysqlPool.query(
        `SELECT imageId, plantId, originalFilename, storedPath, mimeType, status
         FROM plant_images WHERE imageId = ?`,
        [imageId]
    );
    return rows[0] || null;
}

/**
 * Owner serving: the submitter sees their own photo whatever the status, because
 * the only feedback a botanist gets for a rejected upload is the per-request
 * note. The accountId predicate is the entire privacy property of the owner
 * route — written in the style of getImageForReview (which deliberately omits
 * it) this would expose every pending photo to its uploader's rivals. Never
 * public, never cached.
 */
async function getImageForOwner(imageId, accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT imageId, plantId, accountId, originalFilename, storedPath, mimeType, size, status
         FROM plant_images WHERE imageId = ? AND accountId = ?`,
        [imageId, accountId]
    );
    return rows[0] || null;
}

async function getPlantExists(plantId) {
    const [rows] = await mysqlPool.query('SELECT plantId FROM plants WHERE plantId = ?', [plantId]);
    return rows.length > 0;
}

module.exports = {
    listPlants,
    getContributorSummary,
    getPlantDetailSummary,
    listPlantImages,
    getImageForServing,
    getImageForReview,
    getImageForOwner,
    getPlantExists
};
