package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.*
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.Response
import retrofit2.http.*

/** Botanist submissions on routes/plants.js. All need the record_plant permission. */
interface RecordApi {
    @POST("${ApiConfig.PLANTS}/requests")
    suspend fun submitPlant(@Body body: PlantDraftRequest): Response<PlantSubmitResponse>

    /** Description, measurements and/or photos for an existing plant. */
    @Multipart
    @POST("${ApiConfig.PLANTS}/{plantId}/contributions")
    suspend fun contribute(
        @Path("plantId") plantId: String,
        @PartMap fields: Map<String, @JvmSuppressWildcards RequestBody>,
        @Part images: List<MultipartBody.Part>
    ): Response<ContributionResponse>

    @GET("${ApiConfig.PLANTS}/mine")
    suspend fun mine(@Query("page") page: Int, @Query("pageSize") pageSize: Int): Response<MyRequestsPageDto>
}
