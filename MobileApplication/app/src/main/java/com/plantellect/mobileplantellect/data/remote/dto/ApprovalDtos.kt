package com.plantellect.mobileplantellect.data.remote.dto

import kotlinx.serialization.Serializable

/*
 * GET /api/profile/approvals: the Profile > Pending approval tab.
 *   awaitingMe  changes to MY description that I have not answered
 *   mine        changes I asked for that are still open, or were decided since I last looked
 */

/** The description author's answer. status: pending | approved | denied. */
@Serializable data class ApprovalOwnerDto(
    val id: String? = null,
    val name: String? = null,
    val status: String? = null,
    val note: String? = null
)

/** A change somebody asked for on one of MY descriptions. It waits for my answer. */
@Serializable data class AwaitingApprovalDto(
    val requestId: String,
    val plantId: String? = null,
    val plantName: String? = null,
    val scientificName: String? = null,
    val requesterId: String? = null,
    val requesterName: String? = null,
    val createdAt: String? = null,
    val reason: String? = null,
    val changes: Map<String, RecChange>? = null
)

/** A change I asked for. [status] is the admin's side (pending | approved | denied). */
@Serializable data class MyApprovalDto(
    val requestId: String,
    val plantId: String? = null,
    val plantName: String? = null,
    val scientificName: String? = null,
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
