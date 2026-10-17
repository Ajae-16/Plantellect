package com.plantellect.mobileplantellect.data.remote.dto

package com.plantellect.mobileplantellect.data.remote.dto

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNames

// ---------------------------------------------------------------- auth (routes/auth.js)

@Serializable
data class LoginRequest(
    val email: String? = null,       // send exactly one of email / username
    val username: String? = null,
    val password: String,
    val rememberMe: Boolean = false
)

/** Shape of /login and /me. */
@Serializable
data class AccountDto(
    val accountId: String,
    val email: String = "",
    val username: String = "",
    val roles: List<String> = emptyList(),
    val permissions: List<String> = emptyList()
)

@Serializable
data class RegisterResponse(
    val accountId: String,
    val email: String = "",
    val username: String = "",
    val roles: List<String> = emptyList(),
    val permissions: List<String> = emptyList(),
    /** Botanist request still awaiting an admin. The account itself is already a usable 'user'. */
    val pending: Boolean = false,
    val autoApproved: Boolean = false,
    val autoSkipReason: String? = null
) {
    fun toAccount() = AccountDto(accountId, email, username, roles, permissions)
}

@Serializable data class MessageDto(val message: String = "")

/** Every server error: { error }, plus { retryAfter, limit, windowMs } on a 429 scan. */
@Serializable
data class ErrorBody(
    val error: String? = null,
    val retryAfter: Int? = null,
    val limit: Int? = null
)

// ---------------------------------------------------------------- library (routes/plants.js)
// NOTE: plants.js only shows the ROUTES; the JSON comes from listPublicPlants /
// getPublicPlantDetail in config/mysql.js. These field names are a best guess, every
// field is defaulted so a mismatch shows up as empty values, not a crash. Compare with a
// real response (curl /api/plants) and rename.

@Serializable data class PlantTypeDto(val typeId: String = "", val name: String = "")
@Serializable data class PlantTypesResponse(val types: List<PlantTypeDto> = emptyList())

@Serializable
data class PlantSummaryDto(
    val plantId: String,
    val commonName: String = "",
    val scientificName: String = "",
    val typeId: String? = null,
    val typeName: String? = null,
    val heroImageId: String? = null,
    val imageUrl: String? = null
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PlantPageDto(
    @JsonNames("plants", "results") val items: List<PlantSummaryDto> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20
)

@Serializable
data class PlantImageDto(val imageId: String = "", val url: String? = null)

@Serializable
data class PlantDetailDto(
    val plantId: String,
    val commonName: String = "",
    val scientificName: String = "",
    val typeId: String? = null,
    val typeName: String? = null,
    val quantity: Int? = null,
    val kingdom: String? = null,
    val phylum: String? = null,
    val plantClass: String? = null,
    val order: String? = null,
    val family: String? = null,
    val genus: String? = null,
    val species: String? = null,
    val parts: JsonElement? = null,
    val uses: String? = null,
    val benefits: String? = null,
    val harmful: String? = null,
    val images: List<PlantImageDto> = emptyList()
)

// ---------------------------------------------------------------- scan (routes/ml.js)

@Serializable
data class PredictionDto(
    @SerialName("scientific_name") val scientificName: String = "",
    /** Server fills this from plants.commonName when the species is in the library. */
    val commonName: String? = null,
    @SerialName("common_name") val commonNameRaw: String? = null,
    val confidence: Double = 0.0,
    val kind: String = "species",
    val rank: Int? = null,
    /** null = species the library does not have yet. */
    val plantId: String? = null,
    /** Relative path, e.g. /api/plants/{plantId}/images/{imageId}. */
    val imageUrl: String? = null
) {
    val displayName: String get() = commonName ?: commonNameRaw ?: scientificName
}

@Serializable
data class PredictResponse(
    /** Species only; non_plant / other_plant are already stripped by the server. */
    val predictions: List<PredictionDto> = emptyList(),
    @SerialName("top_k") val topK: Int? = null,
    @SerialName("model_id") val modelId: String? = null,
    @SerialName("model_version") val modelVersion: String? = null,
    @SerialName("inference_ms") val inferenceMs: Double? = null,
    /** What the model's #1 guess was: species | non_plant | other_plant. */
    @SerialName("top_kind") val topKind: String? = null,
    /** Present only when the admin runs confidence in 'enforce' mode: e.g. "unrecognized", "uncertain". */
    val outcome: String? = null,
    val reason: String? = null,
    val error: String? = null
)
