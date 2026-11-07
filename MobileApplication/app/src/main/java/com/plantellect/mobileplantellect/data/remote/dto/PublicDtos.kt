package com.plantellect.mobileplantellect.data.remote.dto

import kotlinx.serialization.Serializable

// ---------------------------------------------------------------------------
// Public routes the first version of the app did not call yet.
// ---------------------------------------------------------------------------

/** GET /api/plants/limits (record_plant): what the photo pickers should enforce. The server still decides. */
@Serializable
data class PhotoLimitsDto(
    val maxFilesPerRequest: Int? = null,
    val maxSizeBytes: Long? = null,
    val allowedMimeTypes: List<String> = emptyList(),
    val allowedExtensions: List<String> = emptyList()
)

/** GET /api/plants/taxonomy-suggestions: values already used at each level (kingdom ... species), A-Z. */
@Serializable
data class TaxonomySuggestionsDto(val values: Map<String, List<String>> = emptyMap())

// ---------------------------------------------------------------------------
// Community votes on descriptions (routes/description-votes.js). Wire shapes first,
// then the plain models the screens read.
// ---------------------------------------------------------------------------

@Serializable
data class VoteReasonDto(val code: String, val label: String? = null, val count: Int = 0)

@Serializable
data class DescriptionVoteDto(
    val up: Int = 0,
    val down: Int = 0,
    /** "up", "down" or null. */
    val myVote: String? = null,
    val own: Boolean = false,
    val reasons: List<VoteReasonDto> = emptyList(),
    val notes: List<String> = emptyList()
)

/** GET /api/plants/:plantId/description-votes. [descriptions] is keyed by descriptionId. */
@Serializable
data class VoteSummaryDto(
    val signedIn: Boolean = false,
    val reasons: List<VoteReasonDto> = emptyList(),
    val noteMaxLength: Int = 0,
    val descriptions: Map<String, DescriptionVoteDto> = emptyMap()
)

/** Body of POST .../vote. A down vote needs a reasonCode; reasonNote is only accepted with "other". */
@Serializable
data class VoteRequest(
    val value: String,
    val reasonCode: String? = null,
    val reasonNote: String? = null
)

/** Answer to POST / DELETE .../vote. [hidden] is true when enough down votes just hid the description. */
@Serializable
data class VoteResponseDto(
    val descriptionId: String? = null,
    val up: Int = 0,
    val myVote: String? = null,
    val retracted: Boolean = false,
    val hidden: Boolean = false
)

data class VoteReason(val code: String, val label: String, val count: Int = 0)

data class DescriptionVoteState(
    val up: Int,
    val down: Int,
    /** "up", "down" or null. */
    val myVote: String?,
    val own: Boolean,
    val reasons: List<VoteReason>,
    val notes: List<String>
)

data class VoteSummary(
    val signedIn: Boolean,
    /** The premade down-vote reasons. */
    val reasons: List<VoteReason>,
    val noteMaxLength: Int,
    val byId: Map<String, DescriptionVoteState>
)

sealed interface VoteResult {
    data class Ok(val up: Int, val myVote: String?, val hidden: Boolean) : VoteResult
    data class Err(val message: String) : VoteResult
}

// ---------------------------------------------------------------------------
// The About text (GET /api/about, public): shown on the Home page.
// ---------------------------------------------------------------------------

@Serializable
data class AboutSectionDto(val id: String = "", val heading: String = "", val body: String = "")

@Serializable
data class AboutDto(
    val title: String = "",
    val intro: String = "",
    val sections: List<AboutSectionDto> = emptyList()
)
