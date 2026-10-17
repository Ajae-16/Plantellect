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
    /** The server's (more accurate) answer. [local] is the on-device check that ran first, if any. */
    data class Server(val response: PredictResponse, val local: LocalResult?) : ScanOutcome

    /** Best-effort answer from the phone's MobileNet because the server was not usable. */
    data class OnDevice(val local: LocalResult, val reason: OnDeviceReason) : ScanOutcome

    /** MobileNet is confident this isn't a plant; nothing was uploaded and no quota was spent. */
    data class NotAPlant(val local: LocalResult) : ScanOutcome

    /** HTTP 429 from the per-account scan quota. */
    data class RateLimited(val retryAfterSeconds: Int?, val message: String) : ScanOutcome

    data class Failed(val error: AppError) : ScanOutcome
}

/**
 * Scan pipeline:
 *   1. MobileNet on the phone: plant / not a plant (and a species guess).
 *   2. Confident non_plant      -> stop (NotAPlant). Saves the upload and the quota.
 *   3. Offline                  -> OnDevice result.
 *   4. Online                   -> upload to /ml/predict -> Server result.
 *   5. Server down / timeout    -> OnDevice result instead of an error.
 */
class ScanRepository(
    private val context: Context,
    private val api: MlApi,
    private val caller: ApiCaller,
    private val classifier: com.plantellect.mobileplantellect.data.local.LocalPlantClassifier,
    private val network: NetworkMonitor
) {
    /**
     * @param skipLocalGate true for a "scan anyway" retry after NotAPlant: the on-device model
     *   can be wrong, so the user always gets a way past it.
     */
    suspend fun scan(uri: Uri, topK: Int = 5, skipLocalGate: Boolean = false): ScanOutcome =
        withContext(Dispatchers.Default) {
            val bitmap = try {
                ImagePreparer.load(context, uri)
            } catch (e: Exception) {
                return@withContext ScanOutcome.Failed(AppError.Unexpected("Could not read that photo"))
            }

            val local = classifier.classify(bitmap)

            if (local != null && !skipLocalGate &&
                !local.looksLikePlant && local.best.confidence >= NOT_PLANT_MIN_CONFIDENCE
            ) return@withContext ScanOutcome.NotAPlant(local)

            if (!network.isOnline()) {
                return@withContext local?.let { ScanOutcome.OnDevice(it, OnDeviceReason.NO_CONNECTION) }
                    ?: ScanOutcome.Failed(AppError.Network)
            }

            val jpeg = ImagePreparer.toJpeg(bitmap)
            val image = MultipartBody.Part.createFormData(
                "image", "scan.jpg", jpeg.toRequestBody("image/jpeg".toMediaType())
            )
            val k = topK.toString().toRequestBody("text/plain".toMediaType())

            when (val r = caller.call { api.predict(image, k) }) {
                is ApiResult.Success -> ScanOutcome.Server(r.value, local)
                is ApiResult.Failure -> {
                    val e = r.error
                    when {
                        e is AppError.Http && e.code == 429 -> ScanOutcome.RateLimited(e.retryAfterSeconds, e.message)
                        // Server unreachable, ML service down (502) or timed out (504): fall back.
                        e is AppError.Network || (e is AppError.Http && (e.code == 502 || e.code == 504)) ->
                            local?.let { ScanOutcome.OnDevice(it, OnDeviceReason.SERVER_UNREACHABLE) }
                                ?: ScanOutcome.Failed(e)
                        else -> ScanOutcome.Failed(e)   // 401 / 403 / 400 / 5xx: the UI must say why
                    }
                }
            }
        }

    private companion object {
        /** High on purpose: wrongly blocking a real plant is worse than wasting one upload. */
        const val NOT_PLANT_MIN_CONFIDENCE = 0.85f
    }
}
