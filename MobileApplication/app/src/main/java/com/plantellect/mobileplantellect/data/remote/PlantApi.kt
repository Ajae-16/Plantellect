package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.*
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.*

interface PlantApi {
    @GET("${ApiConfig.PLANTS}/types")
    suspend fun types(): Response<PlantTypesResponse>

    @GET(ApiConfig.PLANTS)
    suspend fun list(
        @Query("search") search: String?,
        @Query("type") type: String?,
        @Query("page") page: Int,
        @Query("pageSize") pageSize: Int
    ): Response<PlantPageDto>

    @GET("${ApiConfig.PLANTS}/{plantId}")
    suspend fun detail(@Path("plantId") plantId: String): Response<PlantDetailDto>

    @GET("${ApiConfig.PLANTS}/{plantId}/images/{imageId}")
    @Streaming
    suspend fun plantImage(
        @Path("plantId") plantId: String,
        @Path("imageId") imageId: String
    ): Response<ResponseBody>

    @GET("${ApiConfig.PLANTS}/mine/images/{imageId}")
    @Streaming
    suspend fun myPlantImage(@Path("imageId") imageId: String): Response<ResponseBody>
}
