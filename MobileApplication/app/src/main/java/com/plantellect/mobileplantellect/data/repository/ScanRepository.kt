package com.plantellect.mobileplantellect.data.repository

import android.content.Context
import android.net.Uri
import com.plantellect.mobileplantellect.data.local.LocalPlantClassifier
import com.plantellect.mobileplantellect.data.local.LocalResult
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.MlApi
import com.plantellect.mobileplantellect.data.remote.dto.PredictResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
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
    private val classifier: com.plantellect.mobileplantellect.data.local.LocalPlantClassifier,
    private val network: NetworkMonitor
) {
    suspend fun scan(uri: Uri, topK: Int = 5, skipLocalGate: Boolean = false): ScanOutcome =
        withContext(Dispatchers.Default) {
            val bitmap = try {
                ImagePreparer.load(context, uri)
            } catch (e: Exception) {
                return@withContext ScanOutcome.Failed(AppError.Unexpected("Could not read that photo"))
            }

            val online = network.isOnline()
            val local = classifier.classify(bitmap, variant = classifier.preferredVariantForOnline(online))

            if (local != null && !skipLocalGate &&
                !local.looksLikePlant && local.best.confidence >= NOT_PLANT_MIN_CONFIDENCE
            ) return@withContext ScanOutcome.NotAPlant(local)

            if (!online) {
                return@withContext local?.let { ScanOutcome.OnDevice(it, OnDeviceReason.NO_CONNECTION) }
                    ?: ScanOutcome.Failed(AppError.Network)
            }

            val jpeg = ImagePreparer.toJpeg(bitmap)
            val image = MultipartBody.Part.createFormData(
                "image", "scan.jpg", jpeg.toRequestBody("image/jpeg".toMediaType())
            )
            val k = topK.coerceIn(1, UploadLimits.MAX_TOP_K).toString().toRequestBody("text/plain".toMediaType())

            var lastError: AppError? = null
            var succeeded: PredictResponse? = null
            for (attempt in 0 until 3) {
                val r = caller.call { api.predict(image, k) }
                when (r) {
                    is ApiResult.Success -> {
                        succeeded = r.value
                        break
                    }
                    is ApiResult.Failure -> {
                        lastError = r.error
                        val e = r.error
                        if (e is AppError.Http && e.code == 429) {
                            return@withContext ScanOutcome.RateLimited(e.retryAfterSeconds, e.message)
                        }
                        val retryable = e is AppError.Network || (e is AppError.Http && (e.code == 502 || e.code == 504))
                        if (retryable && attempt < 2) {
                            delay(1000L * (attempt + 1))
                            continue
                        }
                        if (!retryable) {
                            return@withContext ScanOutcome.Failed(e)
                        }
                    }
                }
            }

            succeeded?.let { ScanOutcome.Server(it, local) }
                ?: local?.let { ScanOutcome.OnDevice(it, OnDeviceReason.SERVER_UNREACHABLE) }
                ?: ScanOutcome.Failed(lastError ?: AppError.Network)
        }

    private companion object {
        const val NOT_PLANT_MIN_CONFIDENCE = 0.85f
    }
}
