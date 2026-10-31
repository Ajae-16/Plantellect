// Public reads.
// Split out of mysql.js; see mysql.js for the combined export list.

const { mysqlPool } = require('./pool-mysql');
const { parsePaging, escapeLike, PARTS_SELECT, partsFromRow, DISCOVERY_TYPE } = require('./shared-mysql');
const { getContributorPeople } = require('./plant-mysql');

/**
 * A plant is publicly visible when it is not archived and has an approved
 * primary description.
 */
const PUBLIC_VISIBILITY = `(p.archivedAt IS NULL AND EXISTS (
    SELECT 1 FROM plant_description pd
    WHERE pd.plantId = p.plantId AND pd.status = 'approved' AND pd.isPrimary = TRUE
))`;

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
                t.typeName, t.typeName AS typeLabel, NULL AS typeIcon, NULL AS typeBadgeClass,
                t.isMedicinal, t.isHarmful, t.toxicityLevel, t.cautionNote,
                (SELECT i.imageId FROM plant_images i
                 WHERE i.plantId = p.plantId AND i.status = 'approved'
                 ORDER BY i.isPrimary DESC, i.uploadedAt ASC LIMIT 1) AS heroImageId,
                (SELECT d.benefits FROM plant_description d
                 WHERE d.plantId = p.plantId AND d.status = 'approved' AND d.isPrimary = TRUE
                 LIMIT 1) AS primaryBenefits,
                (SELECT d.harmful FROM plant_description d
                 WHERE d.plantId = p.plantId AND d.status = 'approved' AND d.isPrimary = TRUE
                 LIMIT 1) AS primaryHarmful
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
            imageUrl: r.heroImageId ? `/api/plants/${r.plantId}/images/${r.heroImageId}` : null,
            description: {
                benefits: r.primaryBenefits || '',
                harmful: r.primaryHarmful || ''
            }
        })),
        total: countRows[0].total,
        page: paging.page,
        pageSize: paging.pageSize
    };
}

async function getPublicPlantDetail(plantId) {
    const [rows] = await mysqlPool.query(
        `SELECT p.plantId, p.commonName, p.scientificName, p.quantity, p.createdAt,
                t.typeName, t.typeName AS typeLabel, NULL AS typeIcon, NULL AS typeBadgeClass,
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
         LEFT JOIN plant_parts pp ON d.partsId = pp.partId
         WHERE d.plantId = ? AND d.status = 'approved'
         ORDER BY d.isPrimary DESC, d.createdAt ASC`,
        [plantId]
    );

    const people = await getContributorPeople(plantId);

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
        recordedBy: people.recordedBy,
        reviewedBy: people.reviewedBy,
        reportedBy: people.reportedBy
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

    const [stats] = await mysqlPool.query(
        `SELECT COUNT(DISTINCT pc.plantId) AS plantCount,
                COALESCE(SUM(CASE WHEN pc.role = 'reviewer' THEN 1 ELSE 0 END), 0) AS reviewedCount,
                COALESCE(SUM(CASE WHEN pc.role = 'reporter' THEN 1 ELSE 0 END), 0) AS reportedCount
         FROM plant_contributors pc
         WHERE pc.accountId = ?`,
        [accountId]
    );

    const contributionSelect = `
        SELECT p.plantId, p.commonName, p.scientificName, pc.role, pc.createdAt,
                t.typeName, t.typeName AS typeLabel,
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
        `SELECT typeId, typeName, isMedicinal, isHarmful, toxicityLevel, cautionNote
         FROM plant_types ORDER BY typeName ASC`
    );
    return rows.map((r) => ({
        typeId: r.typeId,
        typeName: r.typeName,
        label: r.typeName,
        icon: null,
        badgeClass: null,
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
         FROM plants p WHERE p.archivedAt IS NULL AND p.scientificName IN (${placeholders})`,
        names
    );
    return new Map(rows.map((r) => [r.scientificName, r]));
}

/** Species present in the database, in classes.json, or both. */
async function getMlCoverage(classes) {
    const [rows] = await mysqlPool.query(
        `SELECT DISTINCT p.scientificName FROM plants p
         JOIN plant_images i ON i.plantId = p.plantId AND i.status = 'approved'
         WHERE p.archivedAt IS NULL`
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
 * THROWS on failure rather than returning an empty array, so the caller can
 * report `degraded: true` instead of silently disabling the filter.
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