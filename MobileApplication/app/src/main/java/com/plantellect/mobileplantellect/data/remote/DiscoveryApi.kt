package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.*
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.*

interface DiscoveryApi {
    // ---- any signed-in account
    @Multipart
    @POST(ApiConfig.DISCOVERIES)
    suspend fun file(
        @PartMap fields: Map<String, @JvmSuppressWildcards RequestBody>,
        @Part images: List<MultipartBody.Part>
    ): Response<DiscoveryFiledResponse>

    @GET("${ApiConfig.DISCOVERIES}/mine")
    suspend fun mine(@Query("page") page: Int, @Query("pageSize") pageSize: Int): Response<MyDiscoveryPageDto>

    @GET("${ApiConfig.DISCOVERIES}/mine/summary")
    suspend fun summary(): Response<MyDiscoverySummaryDto>

    @POST("${ApiConfig.DISCOVERIES}/{id}/cancel")
    suspend fun cancel(@Path("id") id: String): Response<MessageDto>

    // ---- botanists (record_plant)
    @GET(ApiConfig.DISCOVERIES)
    suspend fun queue(@Query("page") page: Int, @Query("pageSize") pageSize: Int): Response<DiscoveryQueueDto>

    @GET("${ApiConfig.DISCOVERIES}/count")
    suspend fun count(): Response<DiscoveryCountDto>

    @GET("${ApiConfig.DISCOVERIES}/reasons")
    suspend fun reasons(): Response<ReasonsResponse>

    /** 200, or 409 naming the current claimer (two botanists racing: one wins). */
    @POST("${ApiConfig.DISCOVERIES}/{id}/claim") suspend fun claim(@Path("id") id: String): Response<MessageDto>
    @POST("${ApiConfig.DISCOVERIES}/{id}/unclaim") suspend fun unclaim(@Path("id") id: String): Response<MessageDto>
    @POST("${ApiConfig.DISCOVERIES}/{id}/release") suspend fun release(@Path("id") id: String): Response<MessageDto>
    @POST("${ApiConfig.DISCOVERIES}/{id}/resolve") suspend fun resolve(@Path("id") id: String): Response<MessageDto>
    @POST("${ApiConfig.DISCOVERIES}/{id}/reopen") suspend fun reopen(@Path("id") id: String): Response<MessageDto>
    @POST("${ApiConfig.DISCOVERIES}/{id}/reinstate") suspend fun reinstate(@Path("id") id: String): Response<MessageDto>
    @POST("${ApiConfig.DISCOVERIES}/{id}/vote") suspend fun vote(@Path("id") id: String): Response<MessageDto>

    @POST("${ApiConfig.DISCOVERIES}/{id}/disqualify")
    suspend fun disqualify(@Path("id") id: String, @Body body: DisqualifyRequest): Response<MessageDto>

    // ---- images (binary, need session cookie)
    @GET("${ApiConfig.DISCOVERIES}/images/{imageId}")
    @Streaming
    suspend fun ownerImage(@Path("imageId") imageId: String): Response<ResponseBody>

    @GET("${ApiConfig.DISCOVERIES}/report-images/{imageId}")
    @Streaming
    suspend fun reportImage(@Path("imageId") imageId: String): Response<ResponseBody>
}
