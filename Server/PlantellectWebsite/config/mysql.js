// mysql.js exposed, so existing `require('./mysql')` callers keep working unchanged.
// New code can require the specific module it needs instead (e.g. ./user-mysql).

const { mysqlPool } = require('./pool-mysql');
const { parsePaging, DISCOVERY_TYPE, DENIAL_KINDS } = require('./shared-mysql');
const { getPermissionsVersion, getSessionGuard, loadAccountPermissions, bumpPermissionsVersion, getPrivilegedRoleIds, countActiveSuperadmins } = require('./auth-mysql');
const { recordConsent, getConsentState } = require('./registration-mysql');
const { listUsers, setAccountStatus, changeAccountRole, getUserDetail, getUserPhotoPath, createUser, updateUser, adminSetPassword } = require('./user-mysql');
const { listPlantRequests, getRequestDetail } = require('./request-mysql');
const { listPlants, getContributorSummary, getPlantDetailSummary, listPlantImages, getImageForServing, getImageForReview, getImageForOwner, getPlantExists } = require('./plant-mysql');
const { approvePlantRequest, denyPlantRequest } = require('./approval-mysql');
const { hasPriorSubmissionDecision, maybeAutoResolve, processNewRequest } = require('./auto-approval-mysql');
const { validatePlantDraft, validateContribution, createPlantAdditionRequest, createPlantContributionRequest, createPlantTaxonomyRequest, getRecordingPlant, isSafeType, listMyRequests } = require('./record-mysql');
const { DISQUALIFY_REASONS, DISCOVERY_STORAGE_ROOT, countActiveContributors, effectiveNotAPlantThreshold, getDiscoveryFeatureFlag, isAutoDispatchEnabled, createDiscoveryReport, getDiscoveryImageForOwner, getDiscoveryImageForContributor, getDiscoveryImageForReview, listPendingDiscoveries, getDiscoveryCounts, claimDiscovery, unclaimDiscovery, releaseDiscovery, resolveDiscovery, reopenDiscovery, disqualifyDiscovery, reinstateDisqualified, castNotAPlantVote, countNotAPlantVotes, listNotAPlantVoters, adminDisqualifyDiscovery, cancelDiscoveryReport, listMyDiscoveryReports, getMyDiscoverySummary, listDiscoveryReports, purgeClosedDiscoveryPhotos, expireStaleDiscoveryClaims } = require('./discovery-mysql');
const { currentScanWindowStart, scanWindowRetryAfterSeconds, consumeScanQuota } = require('./scan-mysql');
const { listPublicPlants, getPublicPlantDetail, getContributorProfile, listPlantTypes, resolveScientificNames, getMlCoverage, listHandledDiscoverySpecies } = require('./public-mysql');
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
    recordConsent,
    getConsentState,
    listUsers,
    setAccountStatus,
    changeAccountRole,
    getUserDetail,
    getUserPhotoPath,
    createUser,
    updateUser,
    adminSetPassword,
    listPlantRequests,
    getRequestDetail,
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
    countActiveContributors,
    effectiveNotAPlantThreshold,
    getDiscoveryFeatureFlag,
    isAutoDispatchEnabled,
    createDiscoveryReport,
    getDiscoveryImageForOwner,
    getDiscoveryImageForContributor,
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
    getContributorProfile,
    listPlantTypes,
    resolveScientificNames,
    getMlCoverage,
    listHandledDiscoverySpecies,
    getSystemSetting,
    getPlantImageLimits
};
