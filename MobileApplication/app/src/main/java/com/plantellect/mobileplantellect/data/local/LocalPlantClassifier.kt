package com.plantellect.mobileplantellect.data.local

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import org.tensorflow.lite.DataType
import org.tensorflow.lite.Interpreter   // LiteRT keeps the org.tensorflow.lite package for the Interpreter API
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.exp

data class LocalPrediction(val scientificName: String, val kind: String, val confidence: Float)

data class LocalResult(val top: List<LocalPrediction>) {
    val best: LocalPrediction get() = top.first()
    /** other_plant counts as a plant: the model knows it's a plant, just not which species. */
    val looksLikePlant: Boolean get() = best.kind != KIND_NON_PLANT

    companion object { const val KIND_NON_PLANT = "non_plant" }
}

/**
 * On-device MobileNet. Reads from assets/mobilenet/:
 *   plantellect_model.tflite  - the converted model
 *   classes.json              - same format the training notebook writes: {"0": {"scientific","kind",...}}
 *   preprocessing.json        - OPTIONAL {"mode": "raw" | "zero_one" | "minus_one_one"}
 *
 * The input size comes from the model itself. If the .tflite is missing, every call
 * returns null and ScanRepository simply skips the on-device step.
 */
class LocalPlantClassifier(
    private val context: Context,
    private val assetDir: String = "mobilenet"
) {
    private enum class Mode { RAW, ZERO_ONE, MINUS_ONE_ONE }
    private class ClassInfo(val scientific: String, val kind: String)

    private val lock = Any()
    private var interpreter: Interpreter? = null
    private var classes: List<ClassInfo> = emptyList()
    private var mode = Mode.RAW
    private var loadAttempted = false

    val isAvailable: Boolean get() = ensureLoaded()

    private fun ensureLoaded(): Boolean = synchronized(lock) {
        if (interpreter != null) return true
        if (loadAttempted) return false
        loadAttempted = true
        try {
            val bytes = context.assets.open("$assetDir/plantellect_model.tflite").use { it.readBytes() }
            val model = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).put(bytes)
            model.rewind()
            classes = readClasses()
            mode = readMode()
            val interp = Interpreter(model, Interpreter.Options().setNumThreads(4))
            val outputs = interp.getOutputTensor(0).shape().last()
            if (outputs != classes.size) {
                Log.e(TAG, "Model has $outputs outputs but classes.json has ${classes.size} entries")
                interp.close(); return false
            }
            interpreter = interp
            true
        } catch (e: Exception) {
            Log.w(TAG, "On-device model unavailable: ${e.message}")
            false
        }
    }

    /** Blocking; call off the main thread. Returns null when no model is bundled. */
    fun classify(bitmap: Bitmap, topK: Int = 3): LocalResult? {
        if (!ensureLoaded()) return null
        synchronized(lock) {
            val interp = interpreter ?: return null
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
            return LocalResult(top)
        }
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

    /** Keras models usually end in softmax already; apply it only if the output isn't a distribution. */
    private fun normalise(raw: FloatArray): FloatArray {
        val sum = raw.sum()
        if (raw.all { it in 0f..1f } && sum in 0.98f..1.02f) return raw
        val max = raw.max()
        val e = FloatArray(raw.size) { exp(raw[it] - max) }
        val total = e.sum()
        return FloatArray(raw.size) { e[it] / total }
    }

    private fun readClasses(): List<ClassInfo> {
        val root = JSONObject(context.assets.open("$assetDir/classes.json").bufferedReader().use { it.readText() })
        return root.keys().asSequence().map { it.toInt() }.sorted().map { i ->
            val o = root.getJSONObject(i.toString())
            ClassInfo(o.optString("scientific"), o.optString("kind", "species"))
        }.toList()
    }

    private fun readMode(): Mode = try {
        val o = JSONObject(context.assets.open("$assetDir/preprocessing.json").bufferedReader().use { it.readText() })
        when (o.optString("mode", "raw")) {
            "zero_one" -> Mode.ZERO_ONE
            "minus_one_one" -> Mode.MINUS_ONE_ONE
            else -> Mode.RAW
        }
    } catch (e: Exception) { Mode.RAW }

    private companion object { const val TAG = "LocalPlantClassifier" }
}
