package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.PredictResponse
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.Response
import retrofit2.http.*

interface MlApi {
    /** Needs the scan_plant permission. Charged against the per-account quota on every attempt. */
    @Multipart
    @POST("${ApiConfig.ML}/predict")
    suspend fun predict(
        @Part image: MultipartBody.Part,
        @Part("top_k") topK: RequestBody
    ): Response<PredictResponse>
}
