package com.plantellect.mobileplantellect.ui.screen

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.util.LruCache
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.ByteArrayInputStream
import java.io.InputStream

/** Small in-memory cache so scrolling a list does not re-download every photo. */
private val photoCache = LruCache<String, ImageBitmap>(48)

/**
 * A plant's photo on top of the leaf placeholder (like the cards on the web home page).
 * The placeholder shows while the photo loads, and stays if there is no photo or it fails.
 * The caller decides the size and shape (e.g. `.height(120.dp).clip(RoundedCornerShape(12.dp))`).
 * [placeholder] = false is for the full-screen viewer: no backdrop, no leaf.
 */
@Composable
fun PlantPhoto(
    url: String?, name: String, modifier: Modifier = Modifier, maxPx: Int = 512,
    scale: ContentScale = ContentScale.Crop, placeholder: Boolean = true
) {
    val client = (LocalContext.current.applicationContext as PlantellectApp).container.network.okHttpClient
    val bmp by produceState<ImageBitmap?>(url?.let { photoCache.get(it) }, url) {
        if (url.isNullOrBlank()) { value = null; return@produceState }
        photoCache.get(url)?.let { value = it; return@produceState }
        value = withContext(Dispatchers.IO) {
            runCatching {
                val bytes = client.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    if (r.isSuccessful) r.body?.bytes() else null
                }
                bytes?.let { decodePlantBitmap({ ByteArrayInputStream(it) }, maxPx) }
            }.getOrNull()
        }?.also { photoCache.put(url, it) }
    }

    Box(
        if (placeholder) modifier.background(MaterialTheme.colorScheme.surfaceVariant) else modifier,
        contentAlignment = Alignment.Center
    ) {
        if (placeholder) LeafBadge(name, size = 56.dp)
        AnimatedVisibility(visible = bmp != null, enter = fadeIn(), modifier = Modifier.fillMaxSize()) {
            bmp?.let { Image(it, contentDescription = name, modifier = Modifier.fillMaxSize(), contentScale = scale) }
        }
    }
}

/**
 * A card photo. Uses the address the list row gave; when the row has none, asks the plant's
 * detail for its first photo (what home.js does), cached so each plant is asked once.
 */
@Composable
fun PlantCardPhoto(plantId: String, knownUrl: String?, name: String, vm: LibraryViewModel, modifier: Modifier = Modifier) {
    val client = (LocalContext.current.applicationContext as PlantellectApp).container.network.okHttpClient
    val url by produceState<String?>(vm.resolveUrl(knownUrl), plantId, knownUrl) {
        val known = vm.resolveUrl(knownUrl)
        value = known ?: loadHeroUrl(client, vm, plantId)
    }
    PlantPhoto(url = url, name = name, modifier = modifier)
}

/** Decodes a downsampled bitmap (longest side <= maxPx) and applies the EXIF rotation. */
private fun decodePlantBitmap(open: () -> InputStream?, maxPx: Int): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open()?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (bounds.outWidth / sample > maxPx || bounds.outHeight / sample > maxPx) sample *= 2
    val bmp = open()?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
        ?: return null
    val degrees = runCatching {
        open()?.use {
            when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
        } ?: 0f
    }.getOrDefault(0f)
    if (degrees == 0f) return bmp.asImageBitmap()
    val m = Matrix().apply { postRotate(degrees) }
    return Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true).asImageBitmap()
}