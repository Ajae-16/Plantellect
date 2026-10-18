// Public reads.
// Split out of mysql.js; see mysql.js for the combined export list.

const { mysqlPool } = require('./pool-mysql');
const { parsePaging, escapeLike, PARTS_SELECT, partsFromRow, DISCOVERY_TYPE } = require('./shared-mysql');
const { getContributorSummary } = require('./plant-mysql');

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/** Only plants that have an approved primary description are publicly visible. */
const PUBLIC_VISIBILITY = `EXISTS (
    SELECT 1 FROM plant_description pd
    WHERE pd.plantId = p.plantId AND pd.status = 'approved' AND pd.isPrimary = TRUE
)`;

async function listPublicPlants({ search, type, page, pageSize }) {
    const paging = parsePaging({ page, pageSize });
    const where = [PUBLIC_VISIBILITY];
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
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.quantity,
                t.typeName, t.label AS typeLabel, t.icon AS typeIcon, t.badgeClass AS typeBadgeClass,
                t.isMedicinal, t.isHarmful, t.toxicityLevel, t.cautionNote,
                (SELECT i.imageId FROM plant_images i
                 WHERE i.plantId = p.plantId AND i.status = 'approved'
                 ORDER BY i.isPrimary DESC, i.uploadedAt ASC LIMIT 1) AS heroImageId
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         ${whereSql}
         ORDER BY p.commonName ASC
         LIMIT ? OFFSET ?`,
        [...params, paging.pageSize, paging.offset]
    );

    const [countRows] = await mysqlPool.query(
        `SELECT COUNT(*) AS total FROM plants p JOIN plant_types t ON p.typeId = t.typeId ${whereSql}`,
        params
    );

    return {
        plants: rows.map((r) => ({
            id: r.plantId,
            name: r.commonName,
            scientificName: r.scientificName,
            quantity: r.quantity,
            type: r.typeName,
            typeLabel: r.typeLabel,
            typeIcon: r.typeIcon,
            typeBadgeClass: r.typeBadgeClass,
            isMedicinal: Boolean(r.isMedicinal),
            isHarmful: Boolean(r.isHarmful),
            toxicityLevel: r.toxicityLevel,
            cautionNote: r.cautionNote,
            imageUrl: r.heroImageId ? `/api/plants/${r.plantId}/images/${r.heroImageId}` : null
        })),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize
    };
}

async function getPublicPlantDetail(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.quantity, p.createdAt,
                t.typeName, t.label AS typeLabel, t.icon AS typeIcon, t.badgeClass AS typeBadgeClass,
                t.isMedicinal, t.isHarmful, t.toxicityLevel, t.cautionNote
         FROM plants p
         JOIN plant_types t ON p.typeId = t.typeId
         WHERE p.plantId = ? AND ${PUBLIC_VISIBILITY}`,
        [plantId]
    );
    if (rows.length === 0) return null;
    const p = rows[0];

    const [images] = await mysqlPool.query(
        `SELECT imageId, originalFilename FROM plant_images
         WHERE plantId = ? AND status = 'approved'
         ORDER BY isPrimary DESC, uploadedAt ASC`,
        [plantId]
    );

    const [descriptions] = await mysqlPool.query(
        `SELECT d.descriptionId, d.uses, d.benefits, d.harmful, d.isPrimary, d.createdAt,
                a.accountId AS authorId, a.username AS authorName,
                pr.firstName, pr.lastName, pr.specialization,
                ${PARTS_SELECT}
         FROM plant_description d
         JOIN accounts a ON d.accountId = a.accountId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         -- LEFT JOIN, not INNER: a description without measurements must still
         -- be listed, it just reports parts: null.
         LEFT JOIN plant_parts pp ON d.partsId = pp.partId
         WHERE d.plantId = ? AND d.status = 'approved'
         ORDER BY d.isPrimary DESC, d.createdAt ASC`,
        [plantId]
    );

    const summary = await getContributorSummary(plantId);

    return {
        id: p.plantId,
        name: p.commonName,
        scientificName: p.scientificName,
        quantity: p.quantity,
        type: p.typeName,
        typeLabel: p.typeLabel,
        typeIcon: p.typeIcon,
        typeBadgeClass: p.typeBadgeClass,
        isMedicinal: Boolean(p.isMedicinal),
        isHarmful: Boolean(p.isHarmful),
        toxicityLevel: p.toxicityLevel,
        cautionNote: p.cautionNote,
        createdAt: p.createdAt,
        images: images.map((i) => ({
            imageId: i.imageId,
            imageUrl: `/api/plants/${plantId}/images/${i.imageId}`,
            originalFilename: i.originalFilename
        })),
        descriptions: descriptions.map((d) => ({
            descriptionId: d.descriptionId,
            isPrimary: Boolean(d.isPrimary),
            uses: d.uses,
            benefits: d.benefits,
            harmful: d.harmful,
            author: {
                accountId: d.authorId,
                name: [d.firstName, d.lastName].filter(Boolean).join(' ') || d.authorName,
                specialization: d.specialization
            },
            parts: partsFromRow(d),
            createdAt: d.createdAt
        })),
        recordedBy: summary.recordedBy,
        reviewedBy: summary.reviewedBy,
        //  A plant can carry "Reported By: <user>, Recorded By: <botanist>"
        // with no ambiguity about who wrote what.
        reportedBy: summary.reportedBy
    };
}

async function getBotanistProfile(accountId) {
    const [rows] = await mysqlPool.query(
        `SELECT a.accountId, a.username, a.createdAt, r.roleName,
                pr.firstName, pr.lastName, pr.bio, pr.specialization
         FROM accounts a
         JOIN roles r ON a.roleId = r.roleId
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         WHERE a.accountId = ?`,
        [accountId]
    );
    if (rows.length === 0) return null;
    const a = rows[0];

    // reviewedCount stays reviewer-only, and reportedCount is a SEPARATE column
    // for role = 'reporter' — not folded into reviewedCount, and never added to a
    // "contributed" figure. They are different claims and must not blur.
    const [stats] = await mysqlPool.query(
        `SELECT COUNT(DISTINCT pc.plantId) AS plantCount,
                COALESCE(SUM(CASE WHEN pc.role = 'reviewer' THEN 1 ELSE 0 END), 0) AS reviewedCount,
                COALESCE(SUM(CASE WHEN pc.role = 'reporter' THEN 1 ELSE 0 END), 0) AS reportedCount
         FROM plant_contributors pc
         WHERE pc.accountId = ?`,
        [accountId]
    );

    // The verified-contributions grid filters to role = 'contributor'. Without
    // that filter a reported species would render under "No verified
    // contributions yet" as though the reporter had verified it. Filtering is not
    // enough on its own, which is why there is a separate Reported grid below.
    //
    // Both queries are INLINE here — there is no listContributorPlants or
    // getContributorStats function to edit, and a fresh one would omit the
    // PUBLIC_VISIBILITY guard, which is exactly what keeps an unapproved plant off
    // a profile.
    const contributionSelect = `
        SELECT p.plantId, p.commonName, p.scientificName, pc.role, pc.createdAt,
                t.typeName, t.label AS typeLabel,
                (SELECT i.imageId FROM plant_images i
                 WHERE i.plantId = p.plantId AND i.status = 'approved'
                 ORDER BY i.isPrimary DESC, i.uploadedAt ASC LIMIT 1) AS heroImageId
        FROM plant_contributors pc
        JOIN plants p ON pc.plantId = p.plantId
        JOIN plant_types t ON p.typeId = t.typeId`;
    const orderAndVisibility = `
        ORDER BY pc.createdAt DESC`;

    const [contributions] = await mysqlPool.query(
        `${contributionSelect}
         WHERE pc.accountId = ? AND pc.role = 'contributor' AND ${PUBLIC_VISIBILITY}
         ${orderAndVisibility}`,
        [accountId]
    );

    const [reported] = await mysqlPool.query(
        `${contributionSelect}
         WHERE pc.accountId = ? AND pc.role = 'reporter' AND ${PUBLIC_VISIBILITY}
         ${orderAndVisibility}`,
        [accountId]
    );

    return {
        accountId: a.accountId,
        name: [a.firstName, a.lastName].filter(Boolean).join(' ') || a.username,
        username: a.username,
        role: a.roleName,
        bio: a.bio,
        specialization: a.specialization,
        joinedAt: a.createdAt,
        metrics: {
            verifiedPlants: stats[0].plantCount,
            reviewedPlants: stats[0].reviewedCount,
            reportedPlants: Number(stats[0].reportedCount || 0)
        },
        contributions: contributions.map((c) => ({
            id: c.plantId,
            name: c.commonName,
            scientificName: c.scientificName,
            role: c.role,
            type: c.typeName,
            typeLabel: c.typeLabel,
            imageUrl: c.heroImageId ? `/api/plants/${c.plantId}/images/${c.heroImageId}` : null
        })),
        // A separate grid over role = 'reporter', same joins and the same
        // PUBLIC_VISIBILITY guard. Showing the distinction to a reader is better
        // than silently hiding it.
        reported: reported.map((c) => ({
            id: c.plantId,
            name: c.commonName,
            scientificName: c.scientificName,
            role: c.role,
            type: c.typeName,
            typeLabel: c.typeLabel,
            imageUrl: c.heroImageId ? `/api/plants/${c.plantId}/images/${c.heroImageId}` : null
        }))
    };
}

async function listPlantTypes() {
    const [rows] = await mysqlPool.query(
        `SELECT typeId, typeName, label, icon, badgeClass, isMedicinal, isHarmful, toxicityLevel, cautionNote
         FROM plant_types ORDER BY label ASC`
    );
    return rows.map((r) => ({
        typeId: r.typeId,
        typeName: r.typeName,
        label: r.label,
        icon: r.icon,
        badgeClass: r.badgeClass,
        isMedicinal: Boolean(r.isMedicinal),
        isHarmful: Boolean(r.isHarmful),
        toxicityLevel: r.toxicityLevel,
        cautionNote: r.cautionNote
    }));
}

/** Maps ML class names to plant rows, for scan-result linking. */
async function resolveScientificNames(names) {
    if (!names.length) return new Map();
    const placeholders = names.map(() => '?').join(',');
    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.scientificName, p.commonName,
                (SELECT i.imageId FROM plant_images i
                 WHERE i.plantId = p.plantId AND i.status = 'approved'
                 ORDER BY i.isPrimary DESC, i.uploadedAt ASC LIMIT 1) AS heroImageId
         FROM plants p WHERE p.scientificName IN (${placeholders})`,
        names
    );
    return new Map(rows.map((r) => [r.scientificName, r]));
}

/** Species present in the database, in classes.json, or both. */
async function getMlCoverage(classes) {
    const [rows] = await mysqlPool.query(
        `SELECT DISTINCT p.scientificName FROM plants p
         JOIN plant_images i ON i.plantId = p.plantId AND i.status = 'approved'`
    );
    const plantNames = new Set(rows.map((r) => r.scientificName));
    const classNames = new Set(classes.map((c) => c.scientific));
    return {
        matched: [...plantNames].filter((n) => classNames.has(n)),
        plantsOnly: [...plantNames].filter((n) => !classNames.has(n)),
        classesOnly: [...classNames].filter((n) => !plantNames.has(n))
    };
}

/**
 * Every species somebody has already filed a discovery report about, by name.
 *
 * The gap aggregation runs in Mongo and these names live in MySQL, so
 * they have to cross over — which means this endpoint now depends on BOTH
 * databases, and the failure mode to avoid is specific: a MySQL error that
 * returns an UNFILTERED list is indistinguishable from a working card, and it
 * fills the dashboard with species the team already handled. So this THROWS on
 * failure rather than returning an empty array, and the caller turns a throw into
 * `degraded: true` with no rows. An empty array would silently disable the filter
 * and look like a healthy answer.
 *
 * EVERY plant_discovery request counts, whatever its status. A report that was
 * rejected as not-a-plant, withdrawn, or closed by the quorum has all been
 * adjudicated, and re-listing the species is how a signal gets ignored. Only
 * reports that have never been decided are work in progress, and `reported` on the
 * scan feed  already covers the overlap for reports filed
 * straight from a scan.
 *
 * `executor` is a parameter rather than the pool so the failing branch is
 * reachable from a test with a deliberately broken executor, rather than only by
 * breaking a live table.
 */
async function listHandledDiscoverySpecies(executor = mysqlPool) {
    const [rows] = await executor.query(
        `SELECT DISTINCT jt.scientificName
         FROM approval_requests ar
         JOIN JSON_TABLE(
             ar.payload, '$.predictions[*]' COLUMNS (
                 scientificName VARCHAR(255) PATH '$.scientificName'
             )
         ) AS jt
         WHERE ar.requestType = ?
           AND ar.payload IS NOT NULL
           AND jt.scientificName IS NOT NULL
           AND jt.scientificName <> ''`,
        [DISCOVERY_TYPE]
    );
    return rows.map((r) => r.scientificName).filter(Boolean);
}

module.exports = {
    listPublicPlants,
    getPublicPlantDetail,
    getBotanistProfile,
    listPlantTypes,
    resolveScientificNames,
    getMlCoverage,
    listHandledDiscoverySpecies
};
