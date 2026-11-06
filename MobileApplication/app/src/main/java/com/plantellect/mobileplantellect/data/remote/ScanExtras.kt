package com.plantellect.mobileplantellect.data.remote

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part
import retrofit2.http.Path

/**
 * The scan-related server features:
 *  - POST /api/ml/contribute                    "Help improve the ML" (training-only photo, needs the offer token from /predict)
 *  - /api/discoveries                           "Not identified?" report (summary, file)
 *  - POST /api/discoveries/{requestId}/cancel   withdraw the report that was just filed
 *
 * Bodies are read as raw JSON (org.json) in ScanRepository, so this file does not depend on
 * whichever JSON library the other DTOs use.
 *
 * IMPORTANT: use the same path prefix as MlApi.predict(...). If that one is "api/ml/predict",
 * these are right as written; if your Retrofit base URL already ends in /api/, drop the "api/".
 */
interface ScanExtrasApi {

    @Multipart
    @POST("api/ml/contribute")
    suspend fun contribute(
        @Part image: MultipartBody.Part,
        @Part("token") token: RequestBody
    ): Response<ResponseBody>

    @GET("api/discoveries/mine/summary")
    suspend fun reportSummary(): Response<ResponseBody>

    @Multipart
    @POST("api/discoveries")
    suspend fun fileReport(
        @Part("note") note: RequestBody,
        @Part("location") location: RequestBody,
        @Part("predictions") predictions: RequestBody,
        @Part("allowContribution") allowContribution: RequestBody,
        @Part images: MultipartBody.Part?
    ): Response<ResponseBody>

    /** Reporter withdraws their own report. The server answers 409 once it is too late. */
    @POST("api/discoveries/{requestId}/cancel")
    suspend fun cancelReport(@Path("requestId") requestId: String): Response<ResponseBody>
}

/** `contribute_offer` in the /predict answer. Absent unless the server decided this photo may be offered. */
@Serializable
data class ContributeOffer(
    val token: String,
    @SerialName("expires_at") val expiresAt: String? = null,
    /** "species", or "other_plant": a plant the model has no class for (the photo is filed with no plant yet). */
    val kind: String = "species",
    /** The server's own confidence for this offer (0..1), for the offer sentence only. */
    val confidence: Double? = null
) {
    val isOtherPlant: Boolean get() = kind == "other_plant"
}

/** GET /api/discoveries/mine/summary */
data class ReportSummary(
    val open: Int,
    val limit: Int,
    val cooldownMinutes: Int
) {
    val atCap: Boolean get() = open >= limit
}

/** 201 from POST /api/discoveries */
data class ReportReceipt(
    val requestId: String,
    val openReports: Int,
    val maxOpenReports: Int
)

/** A species guess sent along with a report. A hint for the contributor, never an answer. */
data class ReportHint(
    val scientificName: String,
    val commonName: String?,
    val confidence: Double
)

sealed interface ExtrasResult<out T> {
    data class Ok<T>(val value: T) : ExtrasResult<T>

    /** The server answered with an error. [message] is already in plain words; [reason] is its short code. */
    data class Refused(
        val message: String,
        val reason: String,
        val status: Int,
        val retryAfterSeconds: Int? = null
    ) : ExtrasResult<Nothing>

    /** Nothing reached the server. */
    data object NoNetwork : ExtrasResult<Nothing>
}