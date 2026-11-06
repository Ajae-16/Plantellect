package com.plantellect.mobileplantellect.data.repository

import com.plantellect.mobileplantellect.data.logic.ApiCaller
import com.plantellect.mobileplantellect.data.logic.ApiResult
import com.plantellect.mobileplantellect.data.logic.AppError
import com.plantellect.mobileplantellect.data.logic.userMessage
import com.plantellect.mobileplantellect.data.remote.VotesApi
import com.plantellect.mobileplantellect.data.remote.dto.*

/**
 * Thumbs up / down on descriptions. The server enforces every rule (own description, hidden
 * description, reasons, note length); the app only passes the choice on and shows the server's text.
 */
class DescriptionVoteRepository(
    private val api: VotesApi,
    private val caller: ApiCaller
) {
    /** Null when the votes could not be read: no votes UI is better than a broken one. */
    suspend fun summary(plantId: String): VoteSummary? =
        when (val r = caller.call { api.summary(plantId) }) {
            is ApiResult.Success -> r.value.toModel()
            is ApiResult.Failure -> null
        }

    suspend fun up(plantId: String, descriptionId: String): VoteResult =
        cast { api.vote(plantId, descriptionId, VoteRequest(value = "up")) }

    /** [note] only counts with reasonCode "other"; the server rejects a note with any other reason. */
    suspend fun down(plantId: String, descriptionId: String, reasonCode: String, note: String?): VoteResult =
        cast {
            api.vote(
                plantId, descriptionId,
                VoteRequest(value = "down", reasonCode = reasonCode, reasonNote = if (reasonCode == "other") note else null)
            )
        }

    suspend fun retract(plantId: String, descriptionId: String): VoteResult =
        cast { api.retract(plantId, descriptionId) }

    private suspend fun cast(block: suspend () -> retrofit2.Response<VoteResponseDto>): VoteResult =
        when (val r = caller.call(block)) {
            is ApiResult.Success -> VoteResult.Ok(r.value.up, r.value.myVote, r.value.hidden)
            is ApiResult.Failure -> VoteResult.Err(
                when (val e = r.error) {
                    is AppError.Http -> if (e.code == 401) "Sign in to vote." else e.message
                    else -> e.userMessage()
                }
            )
        }

    private fun VoteSummaryDto.toModel() = VoteSummary(
        signedIn = signedIn,
        reasons = reasons.map { it.toModel() },
        noteMaxLength = noteMaxLength.takeIf { it > 0 } ?: 200,
        byId = descriptions.mapValues { (_, d) ->
            DescriptionVoteState(
                up = d.up, down = d.down, myVote = d.myVote, own = d.own,
                reasons = d.reasons.map { it.toModel() }, notes = d.notes
            )
        }
    )

    private fun VoteReasonDto.toModel() = VoteReason(code, label ?: code, count)
}
