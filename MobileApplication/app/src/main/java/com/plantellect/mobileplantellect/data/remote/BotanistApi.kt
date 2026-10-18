package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.BotanistProfileDto
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Path

interface BotanistApi {
    /** Public profile of a botanist (or any account that reported a plant). */
    @GET("${ApiConfig.BOTANISTS}/{accountId}")
    suspend fun profile(@Path("accountId") accountId: String): Response<BotanistProfileDto>
}
