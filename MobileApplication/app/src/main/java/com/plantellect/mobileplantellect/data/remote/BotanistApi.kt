package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.BotanistProfileDto
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Path

interface BotanistApi {
    /** Public profile of a contributor (any account that recorded, reviewed or reported a plant). */
    @GET("${ApiConfig.CONTRIBUTORS}/{accountId}")
    suspend fun profile(@Path("accountId") accountId: String): Response<BotanistProfileDto>
}
