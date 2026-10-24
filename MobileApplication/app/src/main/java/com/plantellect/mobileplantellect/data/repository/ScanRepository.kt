package com.plantellect.mobileplantellect.data.repository

import android.content.Context
import android.net.Uri
import com.plantellect.mobileplantellect.data.local.LocalPlantClassifier
import com.plantellect.mobileplantellect.data.local.LocalResult
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.MlApi
import com.plantellect.mobileplantellect.data.remote.dto.PredictResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody

enum class OnDeviceReason { NO_CONNECTION, SERVER_UNREACHABLE }

sealed interface ScanOutcome {
    data class Server(val response: PredictResponse, val local: LocalResult?) : ScanOutcome
    data class OnDevice(val local: LocalResult, val reason: OnDeviceReason) : ScanOutcome
    data class NotAPlant(val local: LocalResult) : ScanOutcome
    data class RateLimited(val retryAfterSeconds: Int?, val message: String) : ScanOutcome
    data class Failed(val error: AppError) : ScanOutcome
}

class ScanRepository(
    private val context: Context,
    private val api: MlApi,
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
                is ApiResult.Success -> ScanOutcome.Server(r.value, local)
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

    private companion object {
        const val NOT_PLANT_MIN_CONFIDENCE = 0.85f
    }
}
