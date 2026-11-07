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

/** Who last edited a description and when. Absent while the description has never been edited. */
@Serializable data class RecEdit(
    val editedAt: String? = null,
    val editedById: String? = null,
    val editedByName: String? = null,
    val editedByMe: Boolean? = null
)

@Serializable data class RecDescription(
    val descriptionId: String,
    val isPrimary: Boolean? = null,
    val edit: RecEdit? = null,
    val hasPendingChange: Boolean? = null,
    val values: Map<String, JsonElement>? = null
)

/** A description written by SOMEONE ELSE. Changing it needs its author's approval as well as the admin's. */
@Serializable data class RecOtherDescription(
    val descriptionId: String,
    val authorId: String? = null,
    val authorName: String? = null,
    val needsAuthorApproval: Boolean? = null,
    val isPrimary: Boolean? = null,
    val edit: RecEdit? = null,
    val hasPendingChange: Boolean? = null,
    val values: Map<String, JsonElement>? = null
)

/** Who must approve a change to the plant info before an admin does: the plant's primary contributor. */
@Serializable data class RecBaseApproval(
    val needsOwnerApproval: Boolean? = null,
    val ownerId: String? = null,
    val ownerName: String? = null
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
    /** Null when only an admin decides a plant-info change (you are the primary contributor, or there is none). */
    val baseApproval: RecBaseApproval? = null,
    /** Only the signed-in contributor's own descriptions. */
    val descriptions: List<RecDescription>? = null,
    /** Everyone else's descriptions of this plant. */
    val otherDescriptions: List<RecOtherDescription>? = null
)

@Serializable data class RecRequestRef(
    val requestId: String? = null,
    val needsOwnerApproval: Boolean? = null,
    val ownerName: String? = null
)
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

/** The other contributor's answer on a change to their description. status: pending | approved | denied. */
@Serializable data class RecOwnerApproval(
    val ownerId: String? = null,
    val ownerName: String? = null,
    /** "primary" for a change to the plant info; null for a change to someone's description. */
    val role: String? = null,
    val status: String? = null,
    val note: String? = null
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
    val ownerApproval: RecOwnerApproval? = null,
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