package com.plantellect.mobileplantellect.data.local

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import org.tensorflow.lite.DataType
import org.tensorflow.lite.Interpreter
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.exp

data class LocalPrediction(val scientificName: String, val kind: String, val confidence: Float)

data class LocalResult(val top: List<LocalPrediction>) {
    val best: LocalPrediction get() = top.first()
    val looksLikePlant: Boolean get() = best.kind != KIND_NON_PLANT

    companion object { const val KIND_NON_PLANT = "non_plant" }
}

enum class Variant { FP16, FP32 }

private class ClassInfo(val scientific: String, val kind: String)

private enum class Mode { RAW, ZERO_ONE, MINUS_ONE_ONE }

class LocalPlantClassifier(
    private val context: Context,
    private val assetDir: String = ""   // model files sit in the assets root
) {
    private val lock = Any()
    private var interpreterFp16: Interpreter? = null
    private var interpreterFp32: Interpreter? = null
    /** Why the last load failed (null when fine). Shown in the UI so "unavailable" is explainable. */
    @Volatile var lastError: String? = null
        private set
    private fun assetPath(name: String) = if (assetDir.isBlank()) name else "$assetDir/$name"
    private var classes: List<ClassInfo> = emptyList()
    private var mode = Mode.RAW

    /** Returns true if the requested variant is loaded and ready. Does NOT trigger loading. */
    fun isAvailable(online: Boolean, variant: Variant = preferredVariant(online)): Boolean {
        return when (variant) {
            Variant.FP16 -> interpreterFp16 != null
            Variant.FP32 -> interpreterFp32 != null
        }
    }

    /** Tries to load the requested variant. Returns true on success. Call off the main thread. */
    fun ensureLoaded(variant: Variant = Variant.FP32): Boolean = synchronized(lock) {
        when (variant) {
            Variant.FP16 -> ensureLoadedVariant(Variant.FP16)
            Variant.FP32 -> ensureLoadedVariant(Variant.FP32)
        }
    }

    private fun ensureLoadedVariant(variant: Variant): Boolean {
        val interpreter = when (variant) {
            Variant.FP16 -> interpreterFp16
            Variant.FP32 -> interpreterFp32
        }
        if (interpreter != null) return true

        try {
            val modelFile = when (variant) {
                Variant.FP16 -> "plantellect_model_fp16.tflite"
                Variant.FP32 -> "plantellect_model_fp32.tflite"
            }
            val bytes = context.assets.open(assetPath(modelFile)).use { it.readBytes() }
            val model = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).put(bytes)
            model.rewind()

            if (classes.isEmpty()) {
                classes = readClasses()
                mode = readMode()
            }

            val options = Interpreter.Options().apply {
                try { setNumThreads(4) } catch (_: Exception) { /* fall back to default */ }
            }
            val interp = Interpreter(model, options)

            val outputs = interp.getOutputTensor(0).shape().last()
            if (outputs != classes.size) {
                lastError = "Model has $outputs outputs but classes.json has ${classes.size} entries"
                Log.e(TAG, lastError!!)
                interp.close()
                return false
            }

            when (variant) {
                Variant.FP16 -> interpreterFp16 = interp
                Variant.FP32 -> interpreterFp32 = interp
            }
            lastError = null
            return true
        } catch (e: Throwable) {
            // Throwable: a missing native lib is an UnsatisfiedLinkError, not an Exception.
            lastError = "${e.javaClass.simpleName}: ${e.message}"
            Log.w(TAG, "On-device model ($variant) unavailable: $lastError")
            return false
        }
    }

    /** Classifies using the given variant (or preferred for online state). Returns null if unavailable. */
    fun classify(bitmap: Bitmap, topK: Int = 3, variant: Variant = preferredVariant(true)): LocalResult? {
        val effectiveVariant = if (!ensureLoaded(variant)) fallbackVariant(variant) else variant
        if (!ensureLoaded(effectiveVariant)) return null

        return synchronized(lock) {
            val interp = when (effectiveVariant) {
                Variant.FP16 -> interpreterFp16
                Variant.FP32 -> interpreterFp32
            } ?: return@synchronized null

            val inTensor = interp.getInputTensor(0)
            val h = inTensor.shape()[1]
            val w = inTensor.shape()[2]
            val input = toInput(bitmap, w, h, inTensor.dataType())
            val out = Array(1) { FloatArray(classes.size) }
            interp.run(input, out)
            val probs = normalise(out[0])
            val top = probs.indices.sortedByDescending { probs[it] }.take(topK).map {
                LocalPrediction(classes[it].scientific, classes[it].kind, probs[it])
            }
            LocalResult(top)
        }
    }

    private fun preferredVariant(online: Boolean): Variant = Variant.FP32

    fun preferredVariantForOnline(online: Boolean): Variant = preferredVariant(online)

    fun fallbackVariant(variant: Variant): Variant = when (variant) {
        Variant.FP32 -> Variant.FP16
        Variant.FP16 -> Variant.FP32
    }

    private fun toInput(src: Bitmap, w: Int, h: Int, type: DataType): ByteBuffer {
        val scaled = Bitmap.createScaledBitmap(src, w, h, true)
        val pixels = IntArray(w * h)
        scaled.getPixels(pixels, 0, w, 0, 0, w, h)
        if (scaled !== src) scaled.recycle()
        val bytesPer = if (type == DataType.UINT8) 1 else 4
        val buf = ByteBuffer.allocateDirect(w * h * 3 * bytesPer).order(ByteOrder.nativeOrder())
        for (p in pixels) {
            val r = (p shr 16) and 0xFF; val g = (p shr 8) and 0xFF; val b = p and 0xFF
            if (type == DataType.UINT8) {
                buf.put(r.toByte()).put(g.toByte()).put(b.toByte())
            } else for (v in intArrayOf(r, g, b)) buf.putFloat(
                when (mode) {
                    Mode.RAW -> v.toFloat()
                    Mode.ZERO_ONE -> v / 255f
                    Mode.MINUS_ONE_ONE -> v / 127.5f - 1f
                }
            )
        }
        buf.rewind()
        return buf
    }

    private fun normalise(raw: FloatArray): FloatArray {
        val sum = raw.sum()
        if (raw.all { it in 0f..1f } && sum in 0.98f..1.02f) return raw
        val max = raw.max()
        val e = FloatArray(raw.size) { exp(raw[it] - max) }
        val total = e.sum()
        return FloatArray(raw.size) { e[it] / total }
    }

    private fun readClasses(): List<ClassInfo> {
        val root = JSONObject(context.assets.open(assetPath("classes.json")).bufferedReader().use { it.readText() })
        return root.keys().asSequence().map { it.toInt() }.sorted().map { i ->
            val o = root.getJSONObject(i.toString())
            ClassInfo(o.optString("scientific"), o.optString("kind", "species"))
        }.toList()
    }

    private fun readMode(): Mode = try {
        val o = JSONObject(context.assets.open(assetPath("preprocessing.json")).bufferedReader().use { it.readText() })
        when (o.optString("mode", "raw")) {
            "zero_one" -> Mode.ZERO_ONE
            "minus_one_one" -> Mode.MINUS_ONE_ONE
            else -> Mode.RAW
        }
    } catch (e: Exception) { Mode.RAW }

    companion object { private const val TAG = "LocalPlantClassifier" }
}
