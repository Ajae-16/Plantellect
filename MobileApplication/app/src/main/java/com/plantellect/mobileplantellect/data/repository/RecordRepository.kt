package com.plantellect.mobileplantellect.data.repository

import android.content.Context
import android.net.Uri
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.ApiConfig
import com.plantellect.mobileplantellect.data.remote.RecordApi
import com.plantellect.mobileplantellect.data.remote.dto.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
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

    // ---- added for the full record screen ------------------------------------

    private fun text(v: String): RequestBody = v.toRequestBody("text/plain".toMediaType())

    private suspend fun readPhotos(photos: List<Uri>): List<MultipartBody.Part>? =
        try { ImageParts.jpegParts(context, photos) } catch (e: Exception) { null }

    private fun tooMany(photos: List<Uri>): AppError? =
        if (photos.size > UploadLimits.MAX_CONTRIBUTION_PHOTOS)
            AppError.Http(400, "At most ${UploadLimits.MAX_CONTRIBUTION_PHOTOS} photos per submission.")
        else null

    suspend fun types(): ApiResult<List<RecTypeName>> = when (val r = caller.call { api.recordTypes() }) {
        is ApiResult.Success -> ApiResult.Success(r.value.types.orEmpty())
        is ApiResult.Failure -> ApiResult.Failure(r.error)
    }

    suspend fun searchPlants(query: String?, typeName: String?): ApiResult<List<RecPlantItem>> =
        when (val r = caller.call { api.plantsSearch(query?.trim()?.ifBlank { null }, typeName?.ifBlank { null }, 50) }) {
            is ApiResult.Success -> ApiResult.Success(r.value.plants.orEmpty())
            is ApiResult.Failure -> ApiResult.Failure(r.error)
        }

    suspend fun lookupById(plantId: String): ApiResult<RecLookup> = caller.call { api.lookup(plantId, null) }
    suspend fun lookupByName(scientificName: String): ApiResult<RecLookup> = caller.call { api.lookup(null, scientificName.trim()) }

    /** [fields] are the same text fields the web form sends (commonName, typeName, parts as JSON text, ...). */
    suspend fun submitPlantForm(fields: Map<String, String>, photos: List<Uri>): ApiResult<RecSubmitResult> {
        tooMany(photos)?.let { return ApiResult.Failure(it) }
        val images = readPhotos(photos) ?: return ApiResult.Failure(AppError.Unexpected("Could not read one of the photos"))
        val body = fields.mapValues { text(it.value) }
        return caller.call { api.submitPlantForm(body, images) }
    }

    suspend fun contributeForm(plantId: String, fields: Map<String, String>, photos: List<Uri>): ApiResult<RecSubmitResult> {
        tooMany(photos)?.let { return ApiResult.Failure(it) }
        val images = readPhotos(photos) ?: return ApiResult.Failure(AppError.Unexpected("Could not read one of the photos"))
        val body = fields.mapValues { text(it.value) }
        return caller.call { api.contributeForm(plantId, body, images) }
    }

    /** [levels] keyed like the web form: kingdom, phylum, plantClass, order, family, genus, species. */
    suspend fun requestTaxonomy(plantId: String, levels: Map<String, String>, reason: String): ApiResult<RecSubmitResult> {
        val body = buildJsonObject {
            levels.forEach { (k, v) -> put(k, v) }
            put("reason", reason)
        }
        return caller.call { api.requestTaxonomy(plantId, body) }
    }

    suspend fun editable(plantId: String): ApiResult<RecEditable> = caller.call { api.editable(plantId) }

    suspend fun requestChange(plantId: String, body: JsonObject): ApiResult<RecChangeResult> =
        caller.call { api.requestChange(plantId, body) }

    suspend fun myRequests(page: Int, pageSize: Int = 10): ApiResult<RecMinePage> =
        caller.call { api.myRequests(page, pageSize) }

    suspend fun withdraw(requestId: String): ApiResult<MessageDto> = caller.call { api.withdraw(requestId) }
}