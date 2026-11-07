package com.plantellect.mobileplantellect.data.remote.dto

import kotlinx.serialization.Serializable

/*
 * GET /api/profile/approvals: the Profile > Pending approval tab.
 *   awaitingMe  changes sent to ME (to a description I wrote, or to the plant info of a plant I am the primary
 *               contributor of): the ones that still need my answer first, then the ones already answered or settled
 *   mine        changes I asked for: the open ones first, then the approved / denied ones (a denied one is
 *               deleted by the server after 30 days)
 */

/** The contributor's answer. status: pending | approved | denied. [role] is "primary" for a plant-info change. */
@Serializable data class ApprovalOwnerDto(
    val id: String? = null,
    val name: String? = null,
    val role: String? = null,
    val status: String? = null,
    val note: String? = null,
    /** When the contributor answered (ISO text); null while they have not. */
    val decidedAt: String? = null
)

/**
 * A change somebody sent to ME. While [needsAnswer] it waits for my answer; afterwards it stays (at the bottom)
 * with my answer in [ownerStatus] and the request as a whole in [status] (pending | approved | denied).
 */
@Serializable data class AwaitingApprovalDto(
    val requestId: String,
    val plantId: String? = null,
    val plantName: String? = null,
    val scientificName: String? = null,
    /** Relative URL of the plant's photo, or null when it has none. */
    val imageUrl: String? = null,
    val requesterId: String? = null,
    val requesterName: String? = null,
    val createdAt: String? = null,
    val reviewedAt: String? = null,
    val status: String = "pending",
    val ownerStatus: String = "pending",
    val ownerNote: String? = null,
    val ownerDecidedAt: String? = null,
    val needsAnswer: Boolean = true,
    val scope: String? = null,
    val reason: String? = null,
    val changes: Map<String, RecChange>? = null
)

/** A change I asked for. [status] is the admin's side (pending | approved | denied). */
@Serializable data class MyApprovalDto(
    val requestId: String,
    val plantId: String? = null,
    val plantName: String? = null,
    val scientificName: String? = null,
    val imageUrl: String? = null,
    val status: String = "pending",
    val createdAt: String? = null,
    val reviewedAt: String? = null,
    val note: String? = null,
    val unread: Boolean = false,
    /** Null when the change is to my own description: only the admin decides it. */
    val owner: ApprovalOwnerDto? = null,
    val scope: String? = null,
    val reason: String? = null,
    val changes: Map<String, RecChange>? = null
)

@Serializable data class ApprovalsDto(
    val awaitingMe: List<AwaitingApprovalDto> = emptyList(),
    val mine: List<MyApprovalDto> = emptyList(),
    val badge: Int = 0
)

@Serializable data class ApprovalCountDto(val count: Int = 0)

@Serializable data class ApprovalNoteRequest(val note: String? = null)

@Serializable data class ApprovalAnswerDto(
    val requestId: String? = null,
    val ownerStatus: String? = null,
    val status: String? = null,
    val message: String? = null
)
