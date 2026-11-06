package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.*
import retrofit2.Response
import retrofit2.http.*

/**
 * Thumbs up / down on a plant's descriptions (server: routes/description-votes.js).
 * Reading is open to guests; casting or retracting needs the signed-in session cookie.
 */
interface VotesApi {
    @GET("${ApiConfig.PLANTS}/{plantId}/description-votes")
    suspend fun summary(@Path("plantId") plantId: String): Response<VoteSummaryDto>

    @POST("${ApiConfig.PLANTS}/{plantId}/descriptions/{descriptionId}/vote")
    suspend fun vote(
        @Path("plantId") plantId: String,
        @Path("descriptionId") descriptionId: String,
        @Body body: VoteRequest
    ): Response<VoteResponseDto>

    @DELETE("${ApiConfig.PLANTS}/{plantId}/descriptions/{descriptionId}/vote")
    suspend fun retract(
        @Path("plantId") plantId: String,
        @Path("descriptionId") descriptionId: String
    ): Response<VoteResponseDto>
}
