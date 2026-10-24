// mysql.js exposed, so existing `require('./mysql')` callers keep working unchanged.
// New code can require the specific module it needs instead (e.g. ./user-mysql).

const { mysqlPool } = require('./pool-mysql');
const { parsePaging, DISCOVERY_TYPE, DENIAL_KINDS } = require('./shared-mysql');
const { getPermissionsVersion, getSessionGuard, loadAccountPermissions, bumpPermissionsVersion, getPrivilegedRoleIds, countActiveSuperadmins } = require('./auth-mysql');
const { insertCertificate, insertRoleRequest, recordConsent, getConsentState } = require('./registration-mysql');
const { listUsers, setAccountStatus, changeAccountRole } = require('./user-mysql');
const { listPendingRoleRequests, listPlantRequests, getRequestDetail, decideRoleRequest } = require('./request-mysql');
const { listPlants, getContributorSummary, getPlantDetailSummary, listPlantImages, getImageForServing, getImageForReview, getImageForOwner, getPlantExists } = require('./plant-mysql');
const { approvePlantRequest, denyPlantRequest } = require('./approval-mysql');
const { hasPriorSubmissionDecision, maybeAutoResolve, processNewRequest } = require('./auto-approval-mysql');
const { validatePlantDraft, validateContribution, createPlantAdditionRequest, createPlantContributionRequest, createPlantTaxonomyRequest, getRecordingPlant, isSafeType, listMyRequests } = require('./record-mysql');
const { DISQUALIFY_REASONS, DISCOVERY_STORAGE_ROOT, countActiveBotanists, effectiveNotAPlantThreshold, getDiscoveryFeatureFlag, isAutoDispatchEnabled, createDiscoveryReport, getDiscoveryImageForOwner, getDiscoveryImageForBotanist, getDiscoveryImageForReview, listPendingDiscoveries, getDiscoveryCounts, claimDiscovery, unclaimDiscovery, releaseDiscovery, resolveDiscovery, reopenDiscovery, disqualifyDiscovery, reinstateDisqualified, castNotAPlantVote, countNotAPlantVotes, listNotAPlantVoters, adminDisqualifyDiscovery, cancelDiscoveryReport, listMyDiscoveryReports, getMyDiscoverySummary, listDiscoveryReports, purgeClosedDiscoveryPhotos, expireStaleDiscoveryClaims } = require('./discovery-mysql');
const { currentScanWindowStart, scanWindowRetryAfterSeconds, consumeScanQuota } = require('./scan-mysql');
const { listPublicPlants, getPublicPlantDetail, getBotanistProfile, listPlantTypes, resolveScientificNames, getMlCoverage, listHandledDiscoverySpecies } = require('./public-mysql');
const { listCertificatesByAccount, deleteCertificate } = require('./certificate-mysql');
const { getSystemSetting, getPlantImageLimits } = require('./setting-mysql');

module.exports = {
    mysqlPool,
    parsePaging,
    getPermissionsVersion,
    getSessionGuard,
    loadAccountPermissions,
    bumpPermissionsVersion,
    getPrivilegedRoleIds,
    countActiveSuperadmins,
    insertCertificate,
    insertRoleRequest,
    recordConsent,
    getConsentState,
    listUsers,
    setAccountStatus,
    changeAccountRole,
    listPendingRoleRequests,
    listPlantRequests,
    getRequestDetail,
    decideRoleRequest,
    listPlants,
    getContributorSummary,
    getPlantDetailSummary,
    listPlantImages,
    getImageForServing,
    getImageForReview,
    getImageForOwner,
    getPlantExists,
    approvePlantRequest,
    denyPlantRequest,
    validatePlantDraft,
    validateContribution,
    createPlantAdditionRequest,
    createPlantContributionRequest,
    createPlantTaxonomyRequest,
    getRecordingPlant,
    isSafeType,
    listMyRequests,

    // ---- automatic approval (document 3) ----
    hasPriorSubmissionDecision,
    maybeAutoResolve,
    processNewRequest,

    // ---- discovery loop ----
    DISCOVERY_TYPE,
    DISQUALIFY_REASONS,
    DENIAL_KINDS,
    DISCOVERY_STORAGE_ROOT,
    countActiveBotanists,
    effectiveNotAPlantThreshold,
    getDiscoveryFeatureFlag,
    isAutoDispatchEnabled,
    createDiscoveryReport,
    getDiscoveryImageForOwner,
    getDiscoveryImageForBotanist,
    getDiscoveryImageForReview,
    listPendingDiscoveries,
    getDiscoveryCounts,
    claimDiscovery,
    unclaimDiscovery,
    releaseDiscovery,
    resolveDiscovery,
    reopenDiscovery,
    disqualifyDiscovery,
    reinstateDisqualified,
    castNotAPlantVote,
    countNotAPlantVotes,
    listNotAPlantVoters,
    adminDisqualifyDiscovery,
    cancelDiscoveryReport,
    listMyDiscoveryReports,
    getMyDiscoverySummary,
    listDiscoveryReports,
    purgeClosedDiscoveryPhotos,
    expireStaleDiscoveryClaims,

    currentScanWindowStart,
    scanWindowRetryAfterSeconds,
    consumeScanQuota,
    listPublicPlants,
    getPublicPlantDetail,
    getBotanistProfile,
    listPlantTypes,
    resolveScientificNames,
    getMlCoverage,
    listHandledDiscoverySpecies,
    getSystemSetting,
    getPlantImageLimits,
    listCertificatesByAccount,
    deleteCertificate
};
