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
    val retryAfterSeconds: Int? = null,   // discovery filing cooldown uses this name
    val limit: Int? = null
)

// ---------------------------------------------------------------- library (routes/plants.js -> mysql.js)

@Serializable
data class PlantTypeDto(
    val typeId: String = "",
    /** The value the library filter expects: GET /plants?type=<typeName>, NOT typeId. */
    val typeName: String = "",
    val label: String = "",
    val icon: String? = null,
    val isMedicinal: Boolean = false,
    val isHarmful: Boolean = false,
    val toxicityLevel: String? = null,
    val cautionNote: String? = null
)

@Serializable data class PlantTypesResponse(val types: List<PlantTypeDto> = emptyList())

@Serializable
data class PlantSummaryDto(
    val id: String,
    val name: String = "",
    val scientificName: String = "",
    val quantity: Int? = null,
    val type: String = "",
    val typeLabel: String = "",
    val typeIcon: String? = null,
    val isMedicinal: Boolean = false,
    val isHarmful: Boolean = false,
    val toxicityLevel: String? = null,
    val cautionNote: String? = null,
    /** Relative path to the primary approved photo, or null. */
    val imageUrl: String? = null
)

@Serializable
data class PlantPageDto(
    val plants: List<PlantSummaryDto> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20
)

@Serializable
data class PlantImageDto(
    val imageId: String = "",
    val imageUrl: String? = null,
    val originalFilename: String? = null
)

/** Measurements as stored. Values arrive as numbers or decimal strings, so they are kept as text. */
@Serializable
data class PlantPartsDto(
    val heightMinCm: String? = null,
    val heightMaxCm: String? = null,
    val heightNote: String? = null,
    val widthMinCm: String? = null,
    val widthMaxCm: String? = null,
    val widthNote: String? = null,
    val color: String? = null,
    val shape: String? = null,
    val texture: String? = null
)

@Serializable
data class DescriptionAuthorDto(
    val accountId: String = "",
    val name: String = "",
    val specialization: String? = null
)

@Serializable
data class PlantDescriptionDto(
    val descriptionId: String = "",
    val isPrimary: Boolean = false,
    val uses: String? = null,
    val benefits: String? = null,
    val harmful: String? = null,
    val author: DescriptionAuthorDto = DescriptionAuthorDto(),
    /** null when the description has no measurements. */
    val parts: PlantPartsDto? = null,
    val createdAt: String? = null
)

@Serializable
data class PlantDetailDto(
    val id: String,
    val name: String = "",
    val scientificName: String = "",
    val quantity: Int? = null,
    val type: String = "",
    val typeLabel: String = "",
    val typeIcon: String? = null,
    val isMedicinal: Boolean = false,
    val isHarmful: Boolean = false,
    val toxicityLevel: String? = null,
    val cautionNote: String? = null,
    val createdAt: String? = null,
    val images: List<PlantImageDto> = emptyList(),
    val descriptions: List<PlantDescriptionDto> = emptyList(),
    /** Display names joined with "; ". */
    val recordedBy: String = "",
    val reviewedBy: String = "",
    val reportedBy: String = ""
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
    /** Only when the admin runs confidence in 'enforce' mode: identified | uncertain | unrecognized. */
    val outcome: String? = null,
    /** species | non_plant | other_plant | low_confidence | close_call (enforce mode only). */
    val reason: String? = null,
    val error: String? = null
) {
    /** One decision for the UI, whether or not the admin has confidence enforcement switched on. */
    fun verdict(): ScanVerdict = when {
        outcome == "identified" -> ScanVerdict.IDENTIFIED
        outcome == "uncertain" -> ScanVerdict.UNCERTAIN
        outcome == "unrecognized" -> when (reason) {
            "non_plant" -> ScanVerdict.NOT_A_PLANT
            "other_plant" -> ScanVerdict.UNSUPPORTED_PLANT
            else -> ScanVerdict.NOT_RECOGNIZED
        }
        // Enforcement off: fall back on what the model's #1 guess was.
        topKind == "non_plant" -> ScanVerdict.NOT_A_PLANT
        topKind == "other_plant" -> ScanVerdict.UNSUPPORTED_PLANT
        predictions.isNotEmpty() -> ScanVerdict.IDENTIFIED
        else -> ScanVerdict.NOT_RECOGNIZED
    }
}

enum class ScanVerdict {
    /** Show the species. */ IDENTIFIED,
    /** "Possible X: take another photo". Predictions are a short list. */ UNCERTAIN,
    /** "No plant detected". */ NOT_A_PLANT,
    /** "Plant detected, but the species is not supported". A good moment to offer a discovery report. */ UNSUPPORTED_PLANT,
    /** Blurry or too weak to name anything: ask for a clearer photo. */ NOT_RECOGNIZED
}

// ---------------------------------------------------------------- ML model info (GET /api/ml/model/info)

@Serializable
data class ModelInfoDto(
    val modelId: String? = null,
    val modelVersion: String? = null,
    val availableModels: List<AvailableModelDto> = emptyList(),
    val activeModelId: String? = null
)

@Serializable
data class AvailableModelDto(
    val modelId: String = "",
    val version: String = "",
    val isActive: Boolean = false,
    val description: String? = null
)
