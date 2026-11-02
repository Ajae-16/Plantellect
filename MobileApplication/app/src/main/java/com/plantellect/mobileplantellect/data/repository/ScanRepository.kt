package com.plantellect.mobileplantellect.data.repository

import android.content.Context
import android.net.Uri
import com.plantellect.mobileplantellect.data.local.LocalPlantClassifier
import com.plantellect.mobileplantellect.data.local.LocalResult
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.ExtrasResult
import com.plantellect.mobileplantellect.data.remote.MlApi
import com.plantellect.mobileplantellect.data.remote.ReportHint
import com.plantellect.mobileplantellect.data.remote.ReportReceipt
import com.plantellect.mobileplantellect.data.remote.ReportSummary
import com.plantellect.mobileplantellect.data.remote.ScanExtrasApi
import com.plantellect.mobileplantellect.data.remote.dto.PredictResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody
import org.json.JSONArray
import org.json.JSONObject
import retrofit2.Response
import java.io.IOException

enum class OnDeviceReason { NO_CONNECTION, SERVER_UNREACHABLE }

sealed interface ScanOutcome {
    /**
     * [uploadedJpeg] is the EXACT bytes sent to /predict. The server binds a contribution offer to the
     * SHA-256 of those bytes, so "Help improve the ML" must post this array and not a re-encoded copy.
     */
    data class Server(
        val response: PredictResponse,
        val local: LocalResult?,
        val uploadedJpeg: ByteArray? = null
    ) : ScanOutcome

    data class OnDevice(val local: LocalResult, val reason: OnDeviceReason) : ScanOutcome
    data class NotAPlant(val local: LocalResult) : ScanOutcome
    data class RateLimited(val retryAfterSeconds: Int?, val message: String) : ScanOutcome
    data class Failed(val error: AppError) : ScanOutcome
}

class ScanRepository(
    private val context: Context,
    private val api: MlApi,
    private val extras: ScanExtrasApi,
    private val caller: ApiCaller,
    private val classifier: LocalPlantClassifier,
    private val network: NetworkMonitor,
    private val server: ServerMonitor
) {
    suspend fun scan(uri: Uri, topK: Int = 5, skipLocalGate: Boolean = false): ScanOutcome =
        withContext(Dispatchers.Default) {
            val bitmap = try {
                ImagePreparer.load(context, uri)
            } catch (e: Exception) {
                return@withContext ScanOutcome.Failed(AppError.Unexpected("Could not read that photo"))
            }

            // Ask the monitor, never the network stack: when the server can't be reached we must not
            // spend a 15 s connect timeout finding that out. Only the very first scan after launch can
            // find the monitor still undecided; then one short probe (max ~5 s) settles it.
            if (server.status.value == ServerStatus.CHECKING) server.checkNow()
            val reachable = server.isReachable

            val local = classifier.classify(bitmap, variant = classifier.preferredVariantForOnline(reachable))

            if (local != null && !skipLocalGate &&
                !local.looksLikePlant && local.best.confidence >= NOT_PLANT_MIN_CONFIDENCE
            ) return@withContext ScanOutcome.NotAPlant(local)

            if (!reachable) {
                val reason = if (network.hasNetwork()) OnDeviceReason.SERVER_UNREACHABLE else OnDeviceReason.NO_CONNECTION
                return@withContext local?.let { ScanOutcome.OnDevice(it, reason) }
                    ?: ScanOutcome.Failed(AppError.Network)
            }

            val jpeg = ImagePreparer.toJpeg(bitmap)
            val image = MultipartBody.Part.createFormData(
                "image", "scan.jpg", jpeg.toRequestBody("image/jpeg".toMediaType())
            )
            val k = topK.coerceIn(1, UploadLimits.MAX_TOP_K).toString().toRequestBody("text/plain".toMediaType())

            // One attempt only. The server charges quota per attempt, and a dropped connection is
            // answered faster by the on-device result than by waiting for a retry.
            when (val r = caller.call { api.predict(image, k) }) {
                is ApiResult.Success -> ScanOutcome.Server(r.value, local, uploadedJpeg = jpeg)
                is ApiResult.Failure -> {
                    val e = r.error
                    when {
                        e is AppError.Http && e.code == 429 ->
                            ScanOutcome.RateLimited(e.retryAfterSeconds, e.message)
                        e is AppError.Network -> {
                            server.reportFailure()   // the next scans skip the server until a probe succeeds
                            local?.let { ScanOutcome.OnDevice(it, OnDeviceReason.SERVER_UNREACHABLE) }
                                ?: ScanOutcome.Failed(e)
                        }
                        // A server that answers 5xx is not usable right now; 400/401/403 are shown as-is.
                        e is AppError.Http && e.code >= 500 ->
                            local?.let { ScanOutcome.OnDevice(it, OnDeviceReason.SERVER_UNREACHABLE) }
                                ?: ScanOutcome.Failed(e)
                        else -> ScanOutcome.Failed(e)
                    }
                }
            }
        }

    // ====================================================================== "Help improve the ML"

    /**
     * Posts the photo that was scanned plus the offer token from /predict (POST /api/ml/contribute).
     * Private, training-only. The scan quota is not charged. The server decides every answer.
     */
    suspend fun contribute(jpeg: ByteArray, token: String): ExtrasResult<Unit> =
        withContext(Dispatchers.IO) {
            val image = MultipartBody.Part.createFormData(
                "image", "scan.jpg", jpeg.toRequestBody("image/jpeg".toMediaType())
            )
            send({ Unit }) { extras.contribute(image, token.asText()) }
        }

    // ====================================================================== "Not identified?" report

    suspend fun reportSummary(): ExtrasResult<ReportSummary> =
        withContext(Dispatchers.IO) {
            send({ j ->
                ReportSummary(
                    open = j.optInt("open"),
                    limit = j.optInt("limit", 10),
                    cooldownMinutes = j.optInt("cooldownMinutes")
                )
            }) { extras.reportSummary() }
        }

    /**
     * Files a discovery report from the scanned photo. [knownJpeg] is reused when the scan already
     * produced one; otherwise the photo is read from [uri] again (offline / on-device / not-a-plant scans).
     * [allowContribution] is the "also use this photo as a contribution image" tick.
     */
    suspend fun fileReport(
        uri: Uri,
        knownJpeg: ByteArray?,
        note: String,
        location: String,
        hints: List<ReportHint>,
        allowContribution: Boolean
    ): ExtrasResult<ReportReceipt> = withContext(Dispatchers.IO) {
        val jpeg = knownJpeg ?: try {
            ImagePreparer.toJpeg(ImagePreparer.load(context, uri))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return@withContext ExtrasResult.Refused("Could not read that photo.", "no_photo", 0)
        }
        val image = MultipartBody.Part.createFormData(
            "images", "scan-photo.jpg", jpeg.toRequestBody("image/jpeg".toMediaType())
        )
        val hintJson = JSONArray().apply {
            hints.take(10).forEach {
                put(JSONObject().apply {
                    put("scientificName", it.scientificName)
                    put("commonName", it.commonName ?: "")
                    put("confidence", it.confidence)
                })
            }
        }.toString()

        send({ j ->
            ReportReceipt(
                requestId = j.optString("requestId"),
                openReports = j.optInt("openReports"),
                maxOpenReports = j.optInt("maxOpenReports")
            )
        }) {
            extras.fileReport(
                note = note.asText(),
                location = location.asText(),
                predictions = hintJson.asText(),
                allowContribution = (if (allowContribution) "1" else "0").asText(),
                images = image
            )
        }
    }

    /**
     * Withdraws a report the caller filed (POST /api/discoveries/{id}/cancel). The server refuses with
     * 409 once a contributor recorded it or its grace window is over; that message comes back as Refused.
     */
    suspend fun withdrawReport(requestId: String): ExtrasResult<Unit> =
        withContext(Dispatchers.IO) {
            send({ Unit }) { extras.cancelReport(requestId) }
        }

    // ====================================================================== helpers

    private fun String.asText(): RequestBody = toRequestBody("text/plain".toMediaType())

    /** Runs a call and turns it into Ok / Refused (server's own words) / NoNetwork. Never throws except on cancellation. */
    private suspend fun <T> send(
        parse: (JSONObject) -> T,
        block: suspend () -> Response<ResponseBody>
    ): ExtrasResult<T> = try {
        val r = block()
        val text = (if (r.isSuccessful) r.body() else r.errorBody())?.string().orEmpty()
        val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
        if (r.isSuccessful) {
            ExtrasResult.Ok(parse(json))
        } else {
            ExtrasResult.Refused(
                message = json.optString("error").ifBlank { "The request could not be completed." },
                reason = json.optString("reason"),
                status = r.code(),
                retryAfterSeconds = r.headers()["Retry-After"]?.toIntOrNull()
                    ?: json.optInt("retryAfterSeconds").takeIf { it > 0 }
            )
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: IOException) {
        ExtrasResult.NoNetwork
    } catch (e: Exception) {
        ExtrasResult.Refused("Something went wrong. Please try again.", "server_error", 0)
    }

    private companion object {
        const val NOT_PLANT_MIN_CONFIDENCE = 0.85f
    }
}