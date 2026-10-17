package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.*
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.Response
import retrofit2.http.*

interface AuthApi {
    @POST("${ApiConfig.AUTH}/login")
    suspend fun login(@Body body: LoginRequest): Response<AccountDto>

    /** multipart/form-data: the server reads text fields plus an optional 'certificate' file. */
    @Multipart
    @POST("${ApiConfig.AUTH}/register")
    suspend fun register(
        @PartMap fields: Map<String, @JvmSuppressWildcards RequestBody>,
        @Part certificate: MultipartBody.Part?
    ): Response<RegisterResponse>

    @POST("${ApiConfig.AUTH}/logout")
    suspend fun logout(): Response<MessageDto>

    @GET("${ApiConfig.AUTH}/me")
    suspend fun me(): Response<AccountDto>
}
