package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.*
import okhttp3.MultipartBody
import retrofit2.Response
import retrofit2.http.*

/** The signed-in user's own profile. Session cookie auth; there is never an accountId in a path or body. */
interface ProfileApi {
    @GET(ApiConfig.PROFILE)
    suspend fun profile(): Response<ProfileDto>

    /** bio <= 500 characters. "" clears it. */
    @PUT("${ApiConfig.PROFILE}/bio")
    suspend fun updateBio(@Body body: BioRequest): Response<BioResponse>

    /** 403 wrong current password; 429 (+ Retry-After) after 5 wrong guesses. */
    @POST("${ApiConfig.PROFILE}/password")
    suspend fun changePassword(@Body body: PasswordChangeRequest): Response<MessageDto>

    /** multipart field "image". JPEG / PNG / WebP / HEIC, 10 MB max. */
    @Multipart
    @POST("${ApiConfig.PROFILE}/photo")
    suspend fun uploadPhoto(@Part image: MultipartBody.Part): Response<PhotoResponse>

    @DELETE("${ApiConfig.PROFILE}/photo")
    suspend fun removePhoto(): Response<PhotoResponse>
}
