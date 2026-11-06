package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.*
import retrofit2.Response
import retrofit2.http.*

interface AuthApi {
    @POST("${ApiConfig.AUTH}/login")
    suspend fun login(@Body body: LoginRequest): Response<AccountDto>

    /** JSON body. routes/auth.js /register has no upload middleware any more, so multipart would arrive as an empty body. */
    @POST("${ApiConfig.AUTH}/register")
    suspend fun register(@Body body: RegisterRequest): Response<RegisterResponse>

    @POST("${ApiConfig.AUTH}/logout")
    suspend fun logout(): Response<MessageDto>

    @GET("${ApiConfig.AUTH}/me")
    suspend fun me(): Response<AccountDto>
}
