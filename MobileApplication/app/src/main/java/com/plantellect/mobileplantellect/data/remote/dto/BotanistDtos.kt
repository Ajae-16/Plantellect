package com.plantellect.mobileplantellect.data.remote.dto

import kotlinx.serialization.Serializable

// All shapes below come from config/mysql.js (listMyRequests, mapDiscoveryCard, listMyDiscoveryReports, ...).

// ------------------------------------------------ record a plant (routes/plants.js)

/** Measurements for a plant. All optional; the server needs SOME content (see RecordValidator). */
@Serializable
data class PlantPartsInput(
    val heightMinCm: Double? = null,
    val heightMaxCm: Double? = null,
    val heightNote: String? = null,
    val widthMinCm: Double? = null,
    val widthMaxCm: Double? = null,
    val widthNote: String? = null,
    val color: String? = null,
    val shape: String? = null,
    val texture: String? = null
) {
    fun hasAnyValue() = listOf(heightMinCm, heightMaxCm, widthMinCm, widthMaxCm).any { it != null } ||
        listOf(heightNote, widthNote, color, shape, texture).any { !it.isNullOrBlank() }
}

/** POST /api/plants/requests. typeId comes from GET /plants/types. */
@Serializable
data class PlantDraftRequest(
    val commonName: String,
    val scientificName: String,
    val typeId: String,
    val quantity: Int? = null,
    val kingdom: String? = null,
    val phylum: String? = null,
    val plantClass: String? = null,
    val order: String? = null,
    val family: String? = null,
    val genus: String? = null,
    val species: String? = null,
    val parts: PlantPartsInput? = null,
    val uses: String? = null,
    val benefits: String? = null,
    val harmful: String? = null,
    /** Set when the botanist started from a claimed discovery report. The server re-verifies the claim. */
    val discoveryRequestId: String? = null
)

@Serializable
data class PlantSubmitResponse(
    val requestId: String,
    val scientificName: String = "",
    /** e.g. "not a model class, so scans will never link to it". Never blocks the submission. */
    val warnings: List<String> = emptyList(),
    /** true = published with no human review; false = autoSkipReason says why a person will look. */
    val autoApproved: Boolean = false,
    val autoSkipReason: String? = null,
    val message: String = ""
)

@Serializable
data class ContributionResponse(
    val requestId: String,
    val imageIds: List<String> = emptyList(),
    val autoApproved: Boolean = false,
    val autoSkipReason: String? = null,
    val message: String = ""
)

@Serializable
data class MyRequestImageDto(
    val imageId: String = "",
    /** /api/plants/mine/images/{id}: needs the session cookie. */
    val url: String? = null,
    val status: String = "",
    val mimeType: String? = null,
    val size: Long? = null,
    val originalFilename: String? = null
)

@Serializable
data class MyRequestDto(
    val id: String = "",
    /** plant_addition | plant_contribution */
    val requestType: String = "",
    /** pending | approved | denied | ... */
    val status: String = "",
    val targetPlantId: String? = null,
    val targetPlantName: String? = null,
    val note: String? = null,
    val createdAt: String? = null,
    val reviewedAt: String? = null,
    val reviewerLabel: String? = null,
    /** manual | auto: lets the list say "AUTO" instead of naming a person. */
    val approvalMode: String = "manual",
    val discoveryRequestId: String? = null,
    val images: List<MyRequestImageDto> = emptyList()
)

@Serializable
data class MyRequestsPageDto(
    val requests: List<MyRequestDto> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20
)

// ------------------------------------------------ discoveries (routes/discoveries.js)

/** What goes into the `predictions` form field. The server keeps only these three fields (max 10). */
@Serializable
data class ReportPrediction(
    val scientificName: String,
    val commonName: String? = null,
    val confidence: Double = 0.0
)

@Serializable
data class DiscoveryFiledResponse(
    val requestId: String,
    val imageIds: List<String> = emptyList(),
    val openReports: Int = 0,
    val maxOpenReports: Int = 0,
    val dispatchedTo: Int? = null,
    val message: String = ""
)

@Serializable
data class DiscoveryImageDto(
    val imageId: String = "",
    /** /api/discoveries/report-images/{id}: needs the session cookie. */
    val url: String = "",
    val mimeType: String? = null,
    val size: Long? = null,
    val originalFilename: String? = null
)

@Serializable
data class DiscoveryGuessDto(
    val scientificName: String = "",
    val commonName: String? = null,
    val confidence: Double = 0.0
)

/** One card in the BOTANIST queue (mapDiscoveryCard). */
@Serializable
data class DiscoveryCardDto(
    val requestId: String = "",
    val status: String = "",
    val submittedAt: String? = null,
    val note: String? = null,
    val location: String? = null,
    val predictions: List<DiscoveryGuessDto> = emptyList(),
    val reporterId: String? = null,
    val reporterName: String? = null,
    val images: List<DiscoveryImageDto> = emptyList(),
    val photosPurged: Boolean = false,
    /** Set only while the claim is live (a stale claim reads as unclaimed). */
    val claimedBy: String? = null,
    val claimedByName: String? = null,
    val claimedAt: String? = null,
    val claimAgeDays: Int? = null,
    val claimStale: Boolean = false,
    val resolvedBy: String? = null,
    val resolverName: String? = null,
    val recordRequestId: String? = null,
    val recordStatus: String? = null,
    val targetPlantId: String? = null,
    val disqualifiedBy: String? = null,
    val disqualifyReason: String? = null,
    val disqualifierName: String? = null,
    val voteCount: Int = 0,
    val notAPlantThreshold: Int? = null,
    val activeBotanists: Int? = null,
    /** false = somebody is already on it: hide the Claim button. */
    val claimable: Boolean = false
)

@Serializable
data class DiscoveryQueueDto(
    val requests: List<DiscoveryCardDto> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20,
    val activeBotanists: Int? = null,
    val notAPlantThreshold: Int? = null,
    val notAPlantVotes: Int? = null
)

/** Sidebar dot: UNCLAIMED, not pending. */
@Serializable
data class DiscoveryCountDto(val pending: Int = 0, val unclaimed: Int = 0)

/** One of the reporter's OWN reports. */
@Serializable
data class MyDiscoveryReportDto(
    val requestId: String = "",
    val submittedAt: String? = null,
    val note: String? = null,
    val location: String? = null,
    /** /api/discoveries/images/{id}: needs the session cookie. */
    val photoUrl: String? = null,
    /** waiting | recording | added | not_added | not_recorded | not_a_plant | cancelled */
    val state: String = "waiting",
    val reason: String? = null,
    val voterCount: Int = 0,
    /** A WEB link (/plant-profile.html?plantId=...). Use plantId() to open the plant in the app. */
    val plantUrl: String? = null,
    val plantName: String? = null
) {
    fun plantId(): String? = plantUrl?.substringAfter("plantId=", "")?.takeIf { it.isNotBlank() }
}

@Serializable
data class MyDiscoveryPageDto(
    val reports: List<MyDiscoveryReportDto> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20
)

@Serializable
data class MyDiscoverySummaryDto(
    val open: Int = 0,
    val limit: Int = 0,
    val cooldownMinutes: Int = 0,
    /** When the last report was filed: the form can show the cooldown before the user submits. */
    val lastFiledAt: String? = null
)

@Serializable data class DisqualifyRequest(val reason: String)

data class DisqualifyReason(val id: String, val label: String)

/** Closed set: not_a_plant, not_a_photo_of_plant, unusable_image, already_recorded, duplicate. */
@Serializable data class ReasonsResponse(val reasons: List<String> = emptyList())

// ------------------------------------------------ public botanist profile (routes/botanists.js)

@Serializable
data class ProfilePlantDto(
    val id: String = "",
    val name: String = "",
    val scientificName: String = "",
    val role: String = "",
    val type: String = "",
    val typeLabel: String = "",
    val imageUrl: String? = null
)

@Serializable
data class BotanistMetricsDto(
    val verifiedPlants: Int = 0,
    val reviewedPlants: Int = 0,
    val reportedPlants: Int = 0
)

@Serializable
data class BotanistProfileDto(
    val accountId: String = "",
    val name: String = "",
    val username: String = "",
    val role: String = "",
    val bio: String? = null,
    val specialization: String? = null,
    val joinedAt: String? = null,
    val metrics: BotanistMetricsDto = BotanistMetricsDto(),
    /** Plants this botanist recorded. */
    val contributions: List<ProfilePlantDto> = emptyList(),
    /** Plants this account reported (kept separate from contributions on purpose). */
    val reported: List<ProfilePlantDto> = emptyList()
)
