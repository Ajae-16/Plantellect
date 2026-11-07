package com.plantellect.mobileplantellect.ui.screen

import android.os.SystemClock
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlin.math.atan2
import kotlin.math.PI

/*
 * Idle bloom: leave the app alone for a while and a plant grows from the bottom edge of the screen: roots spread
 * under the ground, a stem rises and unfolds its leaves, a bud forms and the flower opens. Then it sways gently.
 * Touch the screen and it wilts at once (a quick droop, about a third of a second) and is gone; the next idle time
 * starts it again.
 *
 * It is drawn in code (no files, no library), in the app's own theme colors. It covers every page that sits
 * inside [IdleBloomHost], it only WATCHES the finger (nothing is consumed), it never blocks a tap, and it is
 * skipped when the phone's animations are off.
 */

/** How long nothing may be touched before the plant starts to grow. Keep it at one minute or less. */
internal const val IDLE_BLOOM_SECONDS = 45

/** How long the growing takes, from the first root to the open flower. */
private const val GROW_MILLIS = 9_000

/** How long the wilting takes. Fast on purpose: the plant droops the moment the screen is touched. */
private const val WILT_MILLIS = 320

/** Where the plant is: not there, growing (or fully grown and swaying), or wilting away. */
private const val PHASE_NONE = 0
private const val PHASE_GROWING = 1
private const val PHASE_WILTING = 2

@Composable
internal fun IdleBloomHost(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val context = LocalContext.current
    val enabled = remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
    }

    var phase by remember { mutableIntStateOf(PHASE_NONE) }
    var lastTouch by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }

    // Count only while the app is in front: coming back to the app starts a fresh count.
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(enabled, owner) {
        if (!enabled) return@LaunchedEffect
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            lastTouch = SystemClock.elapsedRealtime()
            while (true) {
                delay(1_000)
                if (phase == PHASE_NONE && SystemClock.elapsedRealtime() - lastTouch >= IDLE_BLOOM_SECONDS * 1_000L) {
                    phase = PHASE_GROWING
                }
            }
        }
    }

    // A touch while the plant is up starts the wilt; a moment later the plant is removed.
    LaunchedEffect(phase) {
        if (phase == PHASE_WILTING) {
            delay(WILT_MILLIS + 40L)
            phase = PHASE_NONE
            lastTouch = SystemClock.elapsedRealtime()
        }
    }

    Box(
        modifier.pointerInput(Unit) {
            // Initial pass: sees every touch before the children do, and consumes nothing.
            awaitPointerEventScope {
                while (true) {
                    awaitPointerEvent(PointerEventPass.Initial)
                    lastTouch = SystemClock.elapsedRealtime()
                    if (phase == PHASE_GROWING) phase = PHASE_WILTING
                }
            }
        }
    ) {
        content()
        if (enabled && phase != PHASE_NONE) {
            // Drawn over the whole app (every page and the sidebar), and it never takes a touch.
            // Composed fresh every time it appears, so the plant always grows from the start.
            GrowingFlower(
                wilting = phase == PHASE_WILTING,
                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(300.dp).navigationBarsPadding()
            )
        }
    }
}

// ---- the plant ----------------------------------------------------------------------------------------------

// Roots: start x, start y, control 1, control 2, end (dp, relative to where the stem meets the ground).
// The last two are side roots that branch off the first and third.
private val ROOTS = arrayOf(
    floatArrayOf(0f, 0f, -6f, 20f, -22f, 34f, -40f, 52f),
    floatArrayOf(0f, 0f, 4f, 24f, 8f, 40f, 6f, 62f),
    floatArrayOf(0f, 0f, 8f, 16f, 24f, 28f, 46f, 42f),
    floatArrayOf(-14f, 28f, -26f, 32f, -40f, 32f, -56f, 40f),
    floatArrayOf(26f, 29f, 34f, 38f, 38f, 48f, 36f, 62f)
)

// Leaves: how far up the stem they sit (0..1), which side (-1 left, +1 right) and how long (dp).
private val LEAF_AT = floatArrayOf(0.30f, 0.42f, 0.60f, 0.74f)
private val LEAF_SIDE = floatArrayOf(-1f, 1f, -1f, 1f)
private val LEAF_LEN = floatArrayOf(34f, 38f, 32f, 28f)

private val FLOWER_CENTER = Color(0xFFFFC83D)

/** Fades a color toward a dry brown as [w] goes from 0 (fresh) to 1 (wilted). */
private fun wiltColor(base: Color, w: Float): Color = lerp(base, WILT_BROWN, 0.7f * w)

private val WILT_BROWN = Color(0xFF8A6B3F)

private fun smooth(t: Float) = t * t * (3f - 2f * t)

/** How far through the window [from]..[to] [p] is, from 0 to 1. */
private fun phase(p: Float, from: Float, to: Float) = ((p - from) / (to - from)).coerceIn(0f, 1f)

/** The shapes of the plant, built once per size. Nothing is created while it plays. */
private class PlantShapes {
    var w = 0f
    var h = 0f
    var d = 0f
    var cx = 0f
    var groundY = 0f
    var topX = 0f
    var topY = 0f
    var stemLen = 0f

    val stem = Path()
    val stemMeasure = PathMeasure()
    val roots = Array(ROOTS.size) { Path() }
    val rootMeasures = Array(ROOTS.size) { PathMeasure() }
    val rootLen = FloatArray(ROOTS.size)
    val piece = Path()          // the part of a stem or root drawn so far

    /** A leaf of length 1 pointing right (x); scaled and turned when drawn. */
    val leaf = Path().apply {
        moveTo(0f, 0f)
        quadraticTo(0.45f, -0.38f, 1f, 0f)
        quadraticTo(0.45f, 0.38f, 0f, 0f)
        close()
    }

    /** A petal of length 1 pointing right (x). */
    val petal = Path().apply {
        moveTo(0f, 0f)
        cubicTo(0.25f, -0.34f, 0.85f, -0.30f, 1f, 0f)
        cubicTo(0.85f, 0.30f, 0.25f, 0.34f, 0f, 0f)
        close()
    }

    fun ensure(width: Float, height: Float, density: Float) {
        if (width == w && height == h && density == d) return
        w = width; h = height; d = density
        cx = w / 2f
        groundY = h - 70f * d

        stem.rewind()
        stem.moveTo(cx, groundY)
        stem.cubicTo(cx - 26f * d, groundY - 70f * d, cx + 30f * d, groundY - 125f * d, cx + 4f * d, groundY - 185f * d)
        stemMeasure.setPath(stem, false)
        stemLen = stemMeasure.length
        val top = stemMeasure.getPosition(stemLen)
        topX = top.x
        topY = top.y

        for (i in ROOTS.indices) {
            val r = ROOTS[i]
            roots[i].rewind()
            roots[i].moveTo(cx + r[0] * d, groundY + r[1] * d)
            roots[i].cubicTo(
                cx + r[2] * d, groundY + r[3] * d,
                cx + r[4] * d, groundY + r[5] * d,
                cx + r[6] * d, groundY + r[7] * d
            )
            rootMeasures[i].setPath(roots[i], false)
            rootLen[i] = rootMeasures[i].length
        }
    }
}

@Composable
private fun GrowingFlower(wilting: Boolean, modifier: Modifier = Modifier) {
    val c = MaterialTheme.colorScheme
    val shapes = remember { PlantShapes() }

    // 0 -> 1 over the whole growing; the drawing below reads it, so only the drawing is redone each frame.
    val progress = remember { Animatable(0f) }
    // The growing stops where it is the moment the wilt begins (animateTo is cancelled when [wilting] flips).
    LaunchedEffect(wilting) {
        if (!wilting) progress.animateTo(1f, tween(GROW_MILLIS, easing = LinearEasing))
    }

    // 0 = alive, 1 = wilted. Quick: everything droops, dulls and fades within [WILT_MILLIS].
    val wilt = remember { Animatable(0f) }
    LaunchedEffect(wilting) {
        if (wilting) wilt.animateTo(1f, tween(WILT_MILLIS, easing = FastOutSlowInEasing))
    }

    // A gentle sway once there is something to sway.
    val sway by rememberInfiniteTransition(label = "sway").animateFloat(
        initialValue = -1f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(3200, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "swayAngle"
    )

    Canvas(modifier) {
        val d = density
        shapes.ensure(size.width, size.height, d)
        val p = progress.value

        val rootT = smooth(phase(p, 0.00f, 0.22f))
        val sideRootT = smooth(phase(p, 0.12f, 0.34f))
        val stemT = smooth(phase(p, 0.14f, 0.62f))
        val budT = smooth(phase(p, 0.58f, 0.72f))
        val bloomT = smooth(phase(p, 0.70f, 1.00f))
        val seedAlpha = 1f - phase(p, 0.12f, 0.26f)

        val w = wilt.value
        val limp = 1f - 0.85f * w                       // everything above ground fades as it wilts
        val earth = c.onSurfaceVariant.copy(alpha = 0.75f * (1f - 0.9f * w))

        // The ground, a seed, and the roots spreading under it.
        drawLine(
            c.outlineVariant.copy(alpha = 1f - 0.9f * w), Offset(shapes.cx - 56f * d, shapes.groundY), Offset(shapes.cx + 56f * d, shapes.groundY),
            strokeWidth = 2f * d, cap = StrokeCap.Round
        )
        if (seedAlpha > 0f) {
            drawCircle(earth.copy(alpha = 0.75f * seedAlpha), radius = 4.5f * d, center = Offset(shapes.cx, shapes.groundY + 2f * d))
        }
        for (i in ROOTS.indices) {
            val t = if (i < 3) rootT else sideRootT
            if (t <= 0f) continue
            shapes.piece.rewind()
            shapes.rootMeasures[i].getSegment(0f, shapes.rootLen[i] * t, shapes.piece, true)
            drawPath(shapes.piece, earth, style = Stroke(width = (if (i < 3) 2.6f else 1.8f) * d, cap = StrokeCap.Round))
        }

        // Everything above the ground sways around the foot of the stem.
        // When it wilts the whole plant also slumps to one side.
        val swayDeg = sway * 2.2f * stemT * (1f - w) + 34f * w
        withTransform({ rotate(swayDeg, Offset(shapes.cx, shapes.groundY)) }) {
            if (stemT > 0f) {
                shapes.piece.rewind()
                shapes.stemMeasure.getSegment(0f, shapes.stemLen * stemT, shapes.piece, true)
                drawPath(shapes.piece, wiltColor(c.primary, w).copy(alpha = limp), style = Stroke(width = 5f * d, cap = StrokeCap.Round))
            }

            // Leaves unfold once the stem has grown past them.
            for (i in LEAF_AT.indices) {
                val t = smooth(phase(stemT, LEAF_AT[i], LEAF_AT[i] + 0.2f))
                if (t <= 0f) continue
                val at = shapes.stemMeasure.getPosition(shapes.stemLen * LEAF_AT[i])
                val dir = shapes.stemMeasure.getTangent(shapes.stemLen * LEAF_AT[i])
                val heading = atan2(dir.y, dir.x) * (180f / PI.toFloat())
                val len = LEAF_LEN[i] * d * t
                withTransform({
                    translate(at.x, at.y)
                    rotate(heading + LEAF_SIDE[i] * (80f - 25f * t + 55f * w), Offset.Zero)   // leaves fold down
                    scale(len, len, Offset.Zero)
                }) {
                    drawPath(shapes.leaf, wiltColor(c.primary, w).copy(alpha = 0.92f * limp))
                }
            }

            // The bud at the top of the stem.
            if (budT > 0f) {
                drawCircle(wiltColor(c.primary, w).copy(alpha = limp), radius = 8f * d * budT, center = Offset(shapes.topX, shapes.topY))
            }

            // The flower: the petals start folded up like a bud and open outward around the center.
            if (bloomT > 0f) {
                val outer = 36f * d * bloomT * (1f - 0.45f * w)
                for (k in 0 until 8) {
                    withTransform({
                        translate(shapes.topX, shapes.topY)
                        rotate(-90f + k * 45f * bloomT * (1f - 0.7f * w), Offset.Zero)   // petals close up
                        scale(outer, outer, Offset.Zero)
                    }) { drawPath(shapes.petal, wiltColor(c.tertiary, w).copy(alpha = 0.95f * limp)) }
                }
                val inner = 22f * d * bloomT * (1f - 0.45f * w)
                for (k in 0 until 6) {
                    withTransform({
                        translate(shapes.topX, shapes.topY)
                        rotate(-90f + (k * 60f + 30f) * bloomT * (1f - 0.7f * w), Offset.Zero)
                        scale(inner, inner, Offset.Zero)
                    }) { drawPath(shapes.petal, wiltColor(c.secondary, w).copy(alpha = 0.95f * limp)) }
                }
                drawCircle(wiltColor(FLOWER_CENTER, w).copy(alpha = limp), radius = 7f * d * bloomT, center = Offset(shapes.topX, shapes.topY))
            }
        }
    }
}
