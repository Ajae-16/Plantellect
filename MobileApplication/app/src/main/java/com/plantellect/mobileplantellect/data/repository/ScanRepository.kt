package com.plantellect.mobileplantellect.data.repository

import android.content.Context
import android.net.Uri
import com.plantellect.mobileplantellect.data.local.LocalPlantClassifier
import com.plantellect.mobileplantellect.data.local.LocalResult
import com.plantellect.mobileplantellect.data.local.SettingsStore
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
import kotlinx.coroutines.delay
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

enum class OnDeviceReason {
    NO_CONNECTION,
    SERVER_UNREACHABLE,
    /** Settings > Scanning > Offline mode is on: the person chose to scan on the phone only. */
    OFFLINE_MODE
}

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
    private val server: ServerMonitor,
    private val settings: SettingsStore
) {
    /**
     * Two modes, chosen in Settings > Scanning:
     *  - Offline mode ON: the phone's model answers and the server is never contacted.
     *  - Offline mode OFF (default): the server is preferred. When it is found unreachable (before sending, or
     *    because the request fails at connection level), the scan waits [SERVER_RETRY_WAIT_SECONDS] seconds and tries
     *    the server again, up to [SERVER_RETRIES] times, and only then falls back to the phone's model.
     *
     * [onRetryWait] reports the seconds left while waiting (so the screen can say "Retrying in 7 s") and null
     * once the wait is over.
     */
    suspend fun scan(
        uri: Uri,
        topK: Int = 5,
        skipLocalGate: Boolean = false,
        onRetryWait: (Int?) -> Unit = {}
    ): ScanOutcome =
        withContext(Dispatchers.Default) {
            val bitmap = try {
                ImagePreparer.load(context, uri)
            } catch (e: Exception) {
                return@withContext ScanOutcome.Failed(AppError.Unexpected("Could not read that photo"))
            }

            val offlineOnly = settings.offlineMode.value

            // Ask the monitor, never the network stack: when the server can't be reached we must not
            // spend a 15 s connect timeout finding that out. Only the very first scan after launch can
            // find the monitor still undecided; then one short probe (max ~5 s) settles it.
            // Offline mode never asks: the server is not touched at all.
            if (!offlineOnly && server.status.value == ServerStatus.CHECKING) server.checkNow()
            var reachable = !offlineOnly && server.isReachable

            val local = classifier.classify(bitmap, variant = classifier.preferredVariantForOnline(reachable))

            if (local != null && !skipLocalGate &&
                !local.looksLikePlant && local.best.confidence >= NOT_PLANT_MIN_CONFIDENCE
            ) return@withContext ScanOutcome.NotAPlant(local)

            if (offlineOnly) {
                return@withContext local?.let { ScanOutcome.OnDevice(it, OnDeviceReason.OFFLINE_MODE) }
                    ?: ScanOutcome.Failed(
                        AppError.Unexpected("The on-device model is not available. Turn off Offline mode to scan with the server.")
                    )
            }

            fun fallback(error: AppError): ScanOutcome {
                val reason = if (network.hasNetwork()) OnDeviceReason.SERVER_UNREACHABLE else OnDeviceReason.NO_CONNECTION
                return local?.let { ScanOutcome.OnDevice(it, reason) } ?: ScanOutcome.Failed(error)
            }

            val jpeg = ImagePreparer.toJpeg(bitmap)
            val k = topK.coerceIn(1, UploadLimits.MAX_TOP_K).toString().toRequestBody("text/plain".toMediaType())

            var retriesUsed = 0
            while (true) {
                if (!reachable) {
                    // Detected offline. Out of retries -> the phone's answer; otherwise wait, then look again.
                    if (retriesUsed >= SERVER_RETRIES) return@withContext fallback(AppError.Network)
                    retriesUsed++
                    try {
                        for (left in SERVER_RETRY_WAIT_SECONDS downTo 1) {
                            onRetryWait(left)
                            delay(1_000L)
                        }
                    } finally {
                        onRetryWait(null)
                    }
                    // The person may have turned Offline mode on while we waited.
                    if (settings.offlineMode.value) {
                        return@withContext local?.let { ScanOutcome.OnDevice(it, OnDeviceReason.OFFLINE_MODE) }
                            ?: ScanOutcome.Failed(AppError.Network)
                    }
                    reachable = server.checkNow()
                    continue
                }

                // A request body can only be sent once, so each attempt builds its own part.
                val image = MultipartBody.Part.createFormData(
                    "image", "scan.jpg", jpeg.toRequestBody("image/jpeg".toMediaType())
                )
                when (val r = caller.call { api.predict(image, k) }) {
                    is ApiResult.Success -> return@withContext ScanOutcome.Server(r.value, local, uploadedJpeg = jpeg)
                    is ApiResult.Failure -> {
                        val e = r.error
                        when {
                            e is AppError.Http && e.code == 429 ->
                                return@withContext ScanOutcome.RateLimited(e.retryAfterSeconds, e.message)
                            // The connection failed, or a proxy answered for a dead Node server: the request
                            // never produced a result, so it is safe to wait and try again.
                            e is AppError.Network || (e is AppError.Http && e.code in 502..504) -> {
                                server.reportFailure()   // the next scans skip the server until a probe succeeds
                                reachable = false
                            }
                            // Any other 5xx may have been charged against the quota: don't repeat it.
                            e is AppError.Http && e.code >= 500 -> return@withContext fallback(e)
                            // 400/401/403 are shown as-is.
                            else -> return@withContext ScanOutcome.Failed(e)
                        }
                    }
                }
            }
            @Suppress("UNREACHABLE_CODE")
            ScanOutcome.Failed(AppError.Network)
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

    companion object {
        private const val NOT_PLANT_MIN_CONFIDENCE = 0.85f
        /** How long a scan waits after finding the server unreachable before it looks again. */
        const val SERVER_RETRY_WAIT_SECONDS = 10
        /** How many times it waits and retries before using the phone's answer. */
        const val SERVER_RETRIES = 1
    }
}