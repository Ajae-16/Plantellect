package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.plantellect.mobileplantellect.ui.theme.extraColors
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import kotlinx.coroutines.launch

/**
 * Pinch to zoom, drag to move around while zoomed in, double tap to zoom in / back out.
 *
 * [resetKey] puts the zoom back to 1x when it changes (a different photo). [onTap] runs for a single tap
 * while NOT zoomed in, so a tap can still close a viewer; while zoomed in a tap does nothing, which keeps
 * a slip of the finger from throwing the photo away mid-zoom.
 *
 * One finger only moves the content once it is zoomed in, so a parent that scrolls or swipes still gets
 * the one-finger drags of an un-zoomed photo.
 */
@Composable
fun ZoomableBox(
    modifier: Modifier = Modifier,
    resetKey: Any? = null,
    maxScale: Float = 5f,
    doubleTapScale: Float = 2.5f,
    onTap: () -> Unit = {},
    content: @Composable () -> Unit
) {
    var scale by remember(resetKey) { mutableFloatStateOf(1f) }
    var offset by remember(resetKey) { mutableStateOf(Offset.Zero) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val currentOnTap by rememberUpdatedState(onTap)

    // Keeps the photo from being dragged off screen: at scale s the extra size on each side is (s - 1) / 2.
    fun clamp(o: Offset, s: Float): Offset {
        val maxX = size.width * (s - 1f) / 2f
        val maxY = size.height * (s - 1f) / 2f
        return Offset(o.x.coerceIn(-maxX, maxX), o.y.coerceIn(-maxY, maxY))
    }

    Box(
        modifier
            .clipToBounds()
            .onSizeChanged { size = it }
            .pointerInput(resetKey, maxScale, doubleTapScale) {
                detectTapGestures(
                    onTap = { if (scale <= 1.01f) currentOnTap() },
                    onDoubleTap = { tap ->
                        if (scale > 1.01f) {
                            scale = 1f
                            offset = Offset.Zero
                        } else {
                            // Zoom in around the tapped point (the content's origin is its centre).
                            val c = tap - Offset(size.width / 2f, size.height / 2f)
                            scale = doubleTapScale
                            offset = clamp(c - c * doubleTapScale, doubleTapScale)
                        }
                    }
                )
            }
            .pointerInput(resetKey, maxScale) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent(PointerEventPass.Main)
                        val fingers = event.changes.count { it.pressed }
                        // Two fingers always zoom; one finger only pans a photo that is already zoomed in.
                        if (fingers > 1 || scale > 1.01f) {
                            val zoom = event.calculateZoom()
                            val pan = event.calculatePan()
                            val centroid = event.calculateCentroid(useCurrent = false)
                            val next = (scale * zoom).coerceIn(1f, maxScale)
                            if (centroid != Offset.Unspecified) {
                                // Keep the point under the fingers where it is while the scale changes.
                                val c = centroid - Offset(size.width / 2f, size.height / 2f)
                                offset = clamp(c - (c - offset) * (next / scale) + pan, next)
                            }
                            scale = next
                            if (next <= 1.01f) offset = Offset.Zero
                            event.changes.forEach { if (it.positionChanged()) it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                }
            }
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = offset.x
                translationY = offset.y
                transformOrigin = TransformOrigin.Center
            }
    ) { content() }
}

/**
 * A plant photo full screen over a dark backdrop. Pinch or double-tap to zoom, drag to look around, tap the
 * un-zoomed photo (or "Close") to leave.
 */
@Composable
fun PhotoZoomDialog(url: String, name: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.extraColors.overlay.copy(alpha = 0.92f)) {
            Box(Modifier.fillMaxSize()) {
                ZoomableBox(Modifier.fillMaxSize(), resetKey = url, onTap = onClose) {
                    PlantPhoto(
                        url, name, Modifier.fillMaxSize().padding(16.dp),
                        maxPx = 2048, scale = ContentScale.Fit, placeholder = false
                    )
                }
                PlantTextButton(onClose, Modifier.align(Alignment.TopEnd).statusBarsPadding()) {
                    Text("Close", color = MaterialTheme.extraColors.onOverlay)
                }
                Text(
                    "Pinch or double-tap to zoom",
                    Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 12.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.extraColors.onOverlay.copy(alpha = 0.7f)
                )
            }
        }
    }
}

/**
 * Long-press on a plant card to look at its photo big and zoomable (a plain tap still opens the plant).
 * Returns the function to call on long-press; the viewer is shown by this call, so put it inside the card.
 * A card whose list row carries no photo address asks for the plant's first photo, like the card does.
 */
@Composable
fun rememberCardPhotoZoom(plantId: String, photoUrl: String?, name: String, vm: LibraryViewModel): () -> Unit {
    val scope = rememberCoroutineScope()
    var zoomUrl by remember { mutableStateOf<String?>(null) }
    zoomUrl?.let { PhotoZoomDialog(it, name) { zoomUrl = null } }
    return { scope.launch { zoomUrl = vm.resolveUrl(photoUrl) ?: vm.heroUrl(plantId) } }
}
