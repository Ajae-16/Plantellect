package com.plantellect.mobileplantellect.data.repository

import android.content.Context
import android.net.Uri
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.ApiConfig
import com.plantellect.mobileplantellect.data.remote.RecordApi
import com.plantellect.mobileplantellect.data.remote.dto.*
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

/** Botanist submissions. The server decides auto-approval; show autoApproved / autoSkipReason to the user as-is. */
class RecordRepository(
    private val context: Context,
    private val api: RecordApi,
    private val caller: ApiCaller,
    private val json: Json,
    private val baseUrl: String
) {
    /** A duplicate species is accepted: the server converts it into a contribution at approval time. */
    suspend fun submitPlant(draft: PlantDraftRequest): ApiResult<PlantSubmitResponse> {
        val problems = RecordValidator.plant(draft)
        if (problems.isNotEmpty()) return ApiResult.Failure(AppError.Http(400, problems.joinToString("; ")))
        return caller.call { api.submitPlant(draft) }
    }

    suspend fun contribute(
        plantId: String,
        parts: PlantPartsInput?,
        uses: String?,
        benefits: String?,
        harmful: String?,
        photos: List<Uri>,
        discoveryRequestId: String? = null
    ): ApiResult<ContributionResponse> {
        if (photos.size > UploadLimits.MAX_CONTRIBUTION_PHOTOS) {
            return ApiResult.Failure(AppError.Http(400, "At most ${UploadLimits.MAX_CONTRIBUTION_PHOTOS} photos per submission."))
        }
        val problems = RecordValidator.contribution(parts, uses, benefits, harmful, photos.size)
        if (problems.isNotEmpty()) return ApiResult.Failure(AppError.Http(400, problems.joinToString("; ")))

        fun text(v: String): RequestBody = v.toRequestBody("text/plain".toMediaType())
        val fields = buildMap<String, RequestBody> {
            // The server accepts the measurements as JSON text in a form field.
            parts?.takeIf { it.hasAnyValue() }?.let { put("parts", text(json.encodeToString(PlantPartsInput.serializer(), it))) }
            uses?.takeIf { it.isNotBlank() }?.let { put("uses", text(it.trim())) }
            benefits?.takeIf { it.isNotBlank() }?.let { put("benefits", text(it.trim())) }
            harmful?.takeIf { it.isNotBlank() }?.let { put("harmful", text(it.trim())) }
            discoveryRequestId?.let { put("discoveryRequestId", text(it)) }
        }
        val images = try {
            ImageParts.jpegParts(context, photos)
        } catch (e: Exception) {
            return ApiResult.Failure(AppError.Unexpected("Could not read one of the photos"))
        }
        return caller.call { api.contribute(plantId, fields, images) }
    }

    suspend fun mySubmissions(page: Int, pageSize: Int = 20): ApiResult<MyRequestsPageDto> =
        caller.call { api.mine(page, pageSize) }

    /** MyRequestImageDto.url is relative; this makes it absolute. Needs the session cookie (load with the shared OkHttpClient). */
    fun absoluteUrl(path: String?): String? = ApiConfig.absolute(baseUrl, path)
}
