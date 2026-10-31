package com.plantellect.mobileplantellect.data.remote.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/*
 * DTOs for the full record flow (types, lookup, taxonomy, change requests, submissions).
 * Everything is nullable/defaulted so a missing key never crashes parsing.
 * If network.json was built WITHOUT ignoreUnknownKeys = true, add it: the server sends more fields than these.
 */

@Serializable data class RecTypeName(val typeName: String, val plantCount: Int? = null)
@Serializable data class RecTypes(val types: List<RecTypeName>? = null)

@Serializable data class RecPlantItem(
    val id: String,
    val name: String,
    val scientificName: String? = null,
    val typeLabel: String? = null
)
@Serializable data class RecPlantPage(val plants: List<RecPlantItem>? = null)

@Serializable data class RecLookupPlant(
    val id: String,
    val name: String,
    val scientificName: String = "",
    val isSafeType: Boolean? = null,
    val taxonomy: Map<String, String?>? = null,
    val hasPendingTaxonomyRequest: Boolean? = null
)
@Serializable data class RecLookup(val exists: Boolean = false, val plant: RecLookupPlant? = null)

/** Answer of the multipart plant / contribution submissions and of a taxonomy request. */
@Serializable data class RecSubmitResult(
    val requestId: String? = null,
    val autoApproved: Boolean? = null,
    val scientificName: String? = null,
    val imageIds: List<String>? = null,
    val warnings: List<String>? = null
)

@Serializable data class RecEditType(
    val typeName: String? = null,
    val isMedicinal: Boolean? = null,
    val isHarmful: Boolean? = null,
    val toxicityLevel: String? = null,
    val cautionNote: String? = null
)

@Serializable data class RecDescription(
    val descriptionId: String,
    val isPrimary: Boolean? = null,
    val hasPendingChange: Boolean? = null,
    val values: Map<String, JsonElement>? = null
)

/** GET /api/plants/:id/editable: the plant's current values, to build the change form from. */
@Serializable data class RecEditable(
    val id: String,
    val archived: Boolean? = null,
    val isSafeType: Boolean? = null,
    val values: Map<String, JsonElement>? = null,
    val type: RecEditType? = null,
    val taxonomy: Map<String, String?>? = null,
    val hasPendingBase: Boolean? = null,
    val pendingBaseRequestId: String? = null,
    val descriptions: List<RecDescription>? = null
)

@Serializable data class RecRequestRef(val requestId: String? = null)
@Serializable data class RecChangeResult(val requests: List<RecRequestRef>? = null, val requestId: String? = null)

@Serializable data class RecChange(
    val from: JsonElement? = null,
    val to: JsonElement? = null,
    val fromLabel: JsonElement? = null,
    val toLabel: JsonElement? = null
)

@Serializable data class RecMyImage(
    val imageId: String? = null,
    val url: String? = null,
    val status: String? = null,
    val originalFilename: String? = null
)

@Serializable data class RecMyRequest(
    val id: String,
    val requestType: String,
    val status: String,
    val targetPlantId: String? = null,
    val targetPlantName: String? = null,
    val taxonomyChanges: Map<String, RecChange>? = null,
    val changes: Map<String, RecChange>? = null,
    val changeReason: String? = null,
    val changeScope: String? = null,
    val note: String? = null,
    val createdAt: String? = null,
    val reviewedAt: String? = null,
    val reviewerLabel: String? = null,
    val approvalMode: String? = null,
    val discoveryRequestId: String? = null,
    val images: List<RecMyImage>? = null
)

@Serializable data class RecMinePage(
    val requests: List<RecMyRequest>? = null,
    val total: Int? = null,
    val page: Int? = null,
    val pageSize: Int? = null
)

/** JSON value -> display text. Numbers lose a trailing ".0"; null becomes "". */
fun JsonElement?.asText(): String {
    val p = this as? JsonPrimitive ?: return ""
    if (p is JsonNull) return ""
    val c = p.content.trim()
    return if (c.endsWith(".0") && c.dropLast(2).toLongOrNull() != null) c.dropLast(2) else c
}