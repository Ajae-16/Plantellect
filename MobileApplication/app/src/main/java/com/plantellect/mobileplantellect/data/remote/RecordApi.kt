package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.*
import kotlinx.serialization.json.JsonObject
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.Response
import retrofit2.http.*

/** Botanist submissions on routes/plants.js. All need the record_plant permission. */
interface RecordApi {
    // ---- existing (unchanged) ------------------------------------------------
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

    // ---- added for the full record screen ------------------------------------
    /** Names of the plant types in use, most used first. */
    @GET("${ApiConfig.PLANTS}/types")
    suspend fun recordTypes(): Response<RecTypes>

    /** Picker search for the "Add to existing" / "Request change" tabs. */
    @GET(ApiConfig.PLANTS)
    suspend fun plantsSearch(
        @Query("search") search: String?,
        @Query("type") type: String?,
        @Query("pageSize") pageSize: Int
    ): Response<RecPlantPage>

    /** Finds unpublished plants too. Pass exactly one of the two. */
    @GET("${ApiConfig.PLANTS}/lookup")
    suspend fun lookup(
        @Query("plantId") plantId: String?,
        @Query("scientificName") scientificName: String?
    ): Response<RecLookup>

    /** New plant WITH photos (the JSON submitPlant above cannot carry them). */
    @Multipart
    @POST("${ApiConfig.PLANTS}/requests")
    suspend fun submitPlantForm(
        @PartMap fields: Map<String, @JvmSuppressWildcards RequestBody>,
        @Part images: List<MultipartBody.Part>
    ): Response<RecSubmitResult>

    /** Same route as contribute(), but answers with the fields the screen shows (autoApproved, warnings). */
    @Multipart
    @POST("${ApiConfig.PLANTS}/{plantId}/contributions")
    suspend fun contributeForm(
        @Path("plantId") plantId: String,
        @PartMap fields: Map<String, @JvmSuppressWildcards RequestBody>,
        @Part images: List<MultipartBody.Part>
    ): Response<RecSubmitResult>

    @POST("${ApiConfig.PLANTS}/{plantId}/taxonomy")
    suspend fun requestTaxonomy(@Path("plantId") plantId: String, @Body body: JsonObject): Response<RecSubmitResult>

    @GET("${ApiConfig.PLANTS}/{plantId}/editable")
    suspend fun editable(@Path("plantId") plantId: String): Response<RecEditable>

    @POST("${ApiConfig.PLANTS}/{plantId}/changes")
    suspend fun requestChange(@Path("plantId") plantId: String, @Body body: JsonObject): Response<RecChangeResult>

    @GET("${ApiConfig.PLANTS}/mine")
    suspend fun myRequests(@Query("page") page: Int, @Query("pageSize") pageSize: Int): Response<RecMinePage>

    @POST("${ApiConfig.PLANTS}/requests/{id}/withdraw")
    suspend fun withdraw(@Path("id") id: String): Response<MessageDto>
}