package com.plantellect.mobileplantellect.data.logic

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

object ImagePreparer {
    private const val MAX_SIDE = 1280

    /**
     * Decodes and downscales. ImageDecoder (API 28+) applies EXIF rotation itself, so the
     * pixels are upright and the re-encoded JPEG carries no orientation tag: portrait and
     * landscape photos reach both MobileNet and the server the right way up.
     */
    fun load(context: Context, uri: Uri, maxSide: Int = MAX_SIDE): Bitmap {
        val source = ImageDecoder.createSource(context.contentResolver, uri)
        return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE   // we read pixels back
            val longest = max(info.size.width, info.size.height)
            if (longest > maxSide) {
                val scale = maxSide.toFloat() / longest
                decoder.setTargetSize(
                    (info.size.width * scale).roundToInt(),
                    (info.size.height * scale).roundToInt()
                )
            }
        }
    }

    fun toJpeg(bitmap: Bitmap, quality: Int = 88): ByteArray =
        ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()

    /**
     * Re-encodes to JPEG that is at most [maxBytes], lowering quality and then size until it fits.
     * Returns null only if even the smallest attempt is over the limit (practically never).
     */
    fun toJpegUnder(context: Context, uri: Uri, maxBytes: Int): ByteArray? {
        var side = 2048
        while (side >= 512) {
            val bitmap = load(context, uri, maxSide = side)
            for (quality in intArrayOf(90, 80, 70, 55)) {
                val bytes = toJpeg(bitmap, quality)
                if (bytes.size <= maxBytes) return bytes
            }
            bitmap.recycle()
            side /= 2
        }
        return null
    }
}
