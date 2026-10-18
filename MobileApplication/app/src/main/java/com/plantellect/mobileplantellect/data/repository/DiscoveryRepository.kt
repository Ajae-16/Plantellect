package com.plantellect.mobileplantellect.data.repository

import android.content.Context
import android.net.Uri
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.ApiConfig
import com.plantellect.mobileplantellect.data.remote.DiscoveryApi
import com.plantellect.mobileplantellect.data.remote.dto.*
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.Response

class DiscoveryRepository(
    private val context: Context,
    private val api: DiscoveryApi,
    private val caller: ApiCaller,
    private val json: Json,
    private val baseUrl: String
) {
    // ---------------------------------------------------------------- reporter (any signed-in account)

    /**
     * Flags a plant the model could not identify. Needs a note OR at least one photo (server rule).
     * 409 = open-report cap reached; 429 = filing cooldown (retryAfterSeconds on the error).
     * Pass the scan's predictions so the botanist sees what the model guessed.
     */
    suspend fun fileReport(
        note: String?,
        location: String?,
        photos: List<Uri>,
        scanPredictions: List<PredictionDto> = emptyList()
    ): ApiResult<DiscoveryFiledResponse> {
        if (note.isNullOrBlank() && photos.isEmpty()) {
            return ApiResult.Failure(AppError.Http(400, "Add a note or at least one photo."))
        }
        if (photos.size > UploadLimits.MAX_DISCOVERY_PHOTOS) {
            return ApiResult.Failure(AppError.Http(400, "At most ${UploadLimits.MAX_DISCOVERY_PHOTOS} photos per report."))
        }
        fun text(v: String): RequestBody = v.toRequestBody("text/plain".toMediaType())
        // Always pass the scan's guesses when the report comes from a scan: the server uses their names to
        // mark the matching recent scans as "reported", which keeps the species-gap feed from listing it again.
        val hint = scanPredictions.take(5).map {
            ReportPrediction(it.scientificName, it.commonName ?: it.commonNameRaw, it.confidence)
        }
        val fields = buildMap<String, RequestBody> {
            note?.takeIf { it.isNotBlank() }?.let { put("note", text(it.trim())) }
            location?.takeIf { it.isNotBlank() }?.let { put("location", text(it.trim())) }
            if (hint.isNotEmpty()) put("predictions", text(json.encodeToString(ListSerializer(ReportPrediction.serializer()), hint)))
        }
        val images = try {
            ImageParts.jpegParts(context, photos)
        } catch (e: Exception) {
            return ApiResult.Failure(AppError.Unexpected("Could not read one of the photos"))
        }
        return caller.call { api.file(fields, images) }
    }

    suspend fun myReports(page: Int, pageSize: Int = 20) = caller.call { api.mine(page, pageSize) }
    suspend fun mySummary() = caller.call { api.summary() }
    suspend fun cancel(id: String) = caller.call { api.cancel(id) }

    // ---------------------------------------------------------------- botanist queue (record_plant)

    suspend fun queue(page: Int, pageSize: Int = 20) = caller.call { api.queue(page, pageSize) }
    suspend fun count() = caller.call { api.count() }

    /** The closed set the server accepts for a "not a plant" verdict. */
    suspend fun reasons(): ApiResult<List<DisqualifyReason>> =
        caller.call { api.reasons() }.map { r ->
            r.reasons.map { DisqualifyReason(it, it.replace('_', ' ').replaceFirstChar { c -> c.uppercase() }) }
        }

    suspend fun claim(id: String) = act { api.claim(id) }
    suspend fun unclaim(id: String) = act { api.unclaim(id) }
    suspend fun release(id: String) = act { api.release(id) }
    suspend fun resolve(id: String) = act { api.resolve(id) }
    suspend fun reopen(id: String) = act { api.reopen(id) }
    suspend fun reinstate(id: String) = act { api.reinstate(id) }
    suspend fun vote(id: String) = act { api.vote(id) }
    suspend fun disqualify(id: String, reason: String) = act { api.disqualify(id, DisqualifyRequest(reason)) }

    private suspend fun act(block: suspend () -> Response<MessageDto>) = caller.call(block)

    // ---------------------------------------------------------------- photos (need the session cookie: load with the shared OkHttpClient)

    /** The reporter's own photo. */
    fun ownerImageUrl(imageId: String) = "${baseUrl.trimEnd('/')}/${ApiConfig.DISCOVERIES}/images/$imageId"

    /** A report's photo as a botanist sees it. */
    fun reportImageUrl(imageId: String) = "${baseUrl.trimEnd('/')}/${ApiConfig.DISCOVERIES}/report-images/$imageId"
}
