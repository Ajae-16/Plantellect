package com.plantellect.mobileplantellect.ui.screen

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/*
 * The sidebar meadow.
 *
 * A strip of grass and a few flowers grows along the bottom of the sidebar and sways in a light breeze, while
 * dandelion seeds float up through the whole sidebar, behind the menu rows. A very few leaves fall from the top
 * and fade out once they reach the middle of the sidebar.
 *
 * It answers to you in four ways:
 *  - Touch / swipe: the blades bend away from your finger (lay them flat while you hold, they spring back when
 *    you let go) and the seeds near it are blown aside.
 *  - Tap the meadow: a few seeds puff off the blade you tapped.
 *  - Shake the phone: a gust. The blades whip with the shake and the seeds scatter in the direction it pushes them.
 *  - Tilt the phone: the grass leans, and the seeds drift, toward the low side.
 *
 * Nothing external is used: every shape is drawn in code and tinted with the app's own theme colors. No image
 * files, no downloads, nothing to license. The shake and tilt use the accelerometer, which needs no permission.
 *
 * Made to be light:
 *  - A hard cap on blades (34, or 18 in battery saver) and seeds (16, or 8). Fixed arrays, nothing created per
 *    frame, one reused Path, and only the drawing is redone each frame.
 *  - It only runs (and only listens to the sensor) while the sidebar is on screen, and it stays still when the
 *    phone's animations are off.
 *  - It only WATCHES the finger (never consumes a touch), so taps on the rows, scrolling and the sidebar swipe
 *    work exactly as before. The meadow is drawn behind the rows.
 */

private const val MAX_BLADES = 34
private const val LOW_POWER_BLADES = 18
private const val MAX_SEEDS = 16
private const val LOW_POWER_SEEDS = 8
private const val BLADE_REACH_DP = 56f      // how far from a blade tip the finger still bends it
private const val SEED_REACH_DP = 80f       // how far the finger blows seeds
private const val SPRING_K = 38f            // how hard a blade pulls back upright
private const val SPRING_C = 3.2f           // how quickly its wobble dies down
private const val MAX_BEND = 1.2f           // radians: about 69 degrees, "laid flat"
private const val MAX_LEAVES = 4            // falling leaves: kept to a minimum on purpose
private const val LOW_POWER_LEAVES = 2
private const val LEAF_END = 0.5f           // a leaf has faded out completely by this fraction of the sidebar height
private const val GRAVITY = 9.81f
private const val SHAKE_DEADZONE = 1.5f     // m/s2: hand tremor is ignored

// Five bristles fanned out on top of a seed (sine and cosine of -60, -30, 0, 30, 60 degrees).
private val BRISTLE_SIN = floatArrayOf(-0.866f, -0.5f, 0f, 0.5f, 0.866f)
private val BRISTLE_COS = floatArrayOf(0.5f, 0.866f, 1f, 0.866f, 0.5f)

/** The meadow: arrays instead of objects, so a frame creates nothing for the garbage collector. */
internal class LeafField {
    /** How many blades may exist (set by [LeafLayer] before the first frame). */
    var capacity = MAX_BLADES

    /** How many seeds may exist (set by [LeafLayer] before the first frame). */
    var seedCapacity = MAX_SEEDS

    /** How many falling leaves may exist (set by [LeafLayer] before the first frame). */
    var leafCapacity = MAX_LEAVES

    /** False when the phone's animations are off: the meadow is drawn upright, nothing moves. */
    var animated = true

    /** Written once per frame while running; read while drawing, so only the drawing is redone. */
    val tick = mutableLongStateOf(0L)

    var width = 0f
        private set
    var height = 0f
        private set
    var density = 1f
        private set

    // ---- blades (grass and flower stems), one slot each ----
    internal var bladeCount = 0
    internal val bx = FloatArray(MAX_BLADES)         // where the blade stands
    internal val bh = FloatArray(MAX_BLADES)         // its height
    internal val bw = FloatArray(MAX_BLADES)         // half of its width at the base
    internal val th = FloatArray(MAX_BLADES)         // its lean in radians (+ = to the right)
    internal val bhue = ByteArray(MAX_BLADES)        // which theme color
    internal val flower = BooleanArray(MAX_BLADES)   // a stem with a flower on top
    private val om = FloatArray(MAX_BLADES)          // how fast it is swinging
    private val rest = FloatArray(MAX_BLADES)        // the lean it likes when there is no wind
    private val bend = FloatArray(MAX_BLADES)        // taller blades give more to the wind

    /** The one Path the drawing reuses for every blade. */
    internal val path = Path()

    // ---- seeds ----
    internal var seedCount = 0
    internal val sx = FloatArray(MAX_SEEDS)
    internal val sy = FloatArray(MAX_SEEDS)
    internal val sAng = FloatArray(MAX_SEEDS)
    internal val sSize = FloatArray(MAX_SEEDS)
    internal val sHue = ByteArray(MAX_SEEDS)
    private val sFade = FloatArray(MAX_SEEDS)        // 0..1, fades in after (re)starting
    private val svx = FloatArray(MAX_SEEDS)
    private val svy = FloatArray(MAX_SEEDS)
    private val sPhase = FloatArray(MAX_SEEDS)
    private val sFreq = FloatArray(MAX_SEEDS)
    private val sAmp = FloatArray(MAX_SEEDS)
    private val sRise = FloatArray(MAX_SEEDS)
    private val sWeight = FloatArray(MAX_SEEDS)      // light seeds go further when the phone is shaken

    // ---- falling leaves, one slot each ----
    internal var leafCount = 0
    internal val lx = FloatArray(MAX_LEAVES)
    internal val ly = FloatArray(MAX_LEAVES)
    internal val lAng = FloatArray(MAX_LEAVES)
    internal val lSize = FloatArray(MAX_LEAVES)
    internal val lHue = ByteArray(MAX_LEAVES)
    private val lWait = FloatArray(MAX_LEAVES)       // seconds still to wait up in the dark before it starts to fall
    private val lPhase = FloatArray(MAX_LEAVES)
    private val lFreq = FloatArray(MAX_LEAVES)
    private val lAmp = FloatArray(MAX_LEAVES)
    private val lFall = FloatArray(MAX_LEAVES)
    private val lSpin = FloatArray(MAX_LEAVES)

    /** The one Path every leaf is drawn with: a leaf of length 1 pointing right, scaled and turned when drawn. */
    internal val leafShape = Path().apply {
        moveTo(0f, 0f)
        quadraticTo(0.45f, -0.38f, 1f, 0f)
        quadraticTo(0.45f, 0.38f, 0f, 0f)
        close()
    }

    private val rnd = Random(11)
    private var seeded = false
    private var time = 0f
    private var lastPuff = -10f

    // ---- the phone (accelerometer) ----
    private var gx = 0f
    private var gy = 0f
    private var gInit = false
    private var shakeX = 0f
    private var shakeY = 0f
    private var tilt = 0f                            // -1..1: + means the right side is lower

    // ---- the finger (one is enough) ----
    private var touching = false
    private var tx = 0f
    private var ty = 0f
    private var touchVx = 0f
    private var touchVy = 0f

    private fun rf() = rnd.nextFloat()

    /** Called with the size of the sidebar while drawing. Plants the meadow the first time. */
    fun resize(w: Float, h: Float, d: Float) {
        if (w <= 0f || h <= 0f) return
        if (seeded && abs(w - width) < 1f && abs(h - height) < 1f && d == density) return
        width = w; height = h; density = d
        seeded = true
        bladeCount = capacity.coerceIn(1, MAX_BLADES)
        seedCount = seedCapacity.coerceIn(1, MAX_SEEDS)
        for (i in 0 until bladeCount) initBlade(i)
        leafCount = leafCapacity.coerceIn(0, MAX_LEAVES)
        // Staggered, so they do not all come down together.
        for (i in 0 until leafCount) initLeaf(i, 1f + i * 3.5f + rf() * 2f)
        for (i in 0 until seedCount) {
            initSeed(i)
            sx[i] = rf() * width
            sy[i] = rf() * height
            sFade[i] = 1f
        }
    }

    private fun initBlade(i: Int) {
        val isFlower = i % 7 == 3
        flower[i] = isFlower
        bx[i] = ((i + 0.5f + (rf() - 0.5f) * 0.6f) / bladeCount) * width
        bh[i] = (if (isFlower) 62f + rf() * 20f else 26f + rf() * 30f) * density
        bw[i] = (if (isFlower) 1.3f + rf() * 0.5f else 2.4f + rf() * 1.4f) * density
        rest[i] = (rf() - 0.5f) * 0.24f
        bend[i] = 0.7f + bh[i] / (density * 60f)
        bhue[i] = if (isFlower) 0 else (if (rf() < 0.5f) 0 else 1)
        th[i] = rest[i]
        om[i] = 0f
    }

    private fun initSeed(i: Int) {
        sSize[i] = 0.7f + rf() * 0.6f
        sHue[i] = if (rf() < 0.5f) 0 else 2
        sFreq[i] = 0.8f + rf() * 1.0f
        sAmp[i] = (10f + rf() * 14f) * density
        sRise[i] = (14f + rf() * 18f) * density
        sWeight[i] = 0.6f + rf() * 0.8f
        sPhase[i] = rf() * 6.2832f
        svx[i] = 0f
        svy[i] = -sRise[i]
        sAng[i] = 0f
        sFade[i] = 0f
    }

    /** A leaf starts again just above the top of the sidebar after waiting [wait] seconds. */
    private fun initLeaf(i: Int, wait: Float) {
        lSize[i] = (12f + rf() * 6f) * density
        lHue[i] = if (rf() < 0.6f) 0 else 1
        lFreq[i] = 0.9f + rf() * 0.8f
        lAmp[i] = (14f + rf() * 14f) * density
        lFall[i] = (26f + rf() * 14f) * density
        lSpin[i] = (rf() - 0.5f) * 70f
        lPhase[i] = rf() * 6.2832f
        lAng[i] = rf() * 360f
        lx[i] = (0.12f + rf() * 0.76f) * width
        ly[i] = -lSize[i]
        lWait[i] = wait
    }

    /** How visible leaf [i] is: it fades in as it enters and is gone by [LEAF_END] of the sidebar's height. */
    internal fun leafAlpha(i: Int): Float {
        if (lWait[i] > 0f) return 0f
        val fadeIn = ((ly[i] + lSize[i]) / (36f * density)).coerceIn(0f, 1f)
        val fadeOut = ((LEAF_END * height - ly[i]) / (0.16f * height)).coerceIn(0f, 1f)
        return fadeIn * fadeOut
    }

    /** A seed that floated off the top (or was blown away) starts again out of the grass. */
    private fun respawnSeed(i: Int) {
        initSeed(i)
        sx[i] = rf() * width
        sy[i] = height - rf() * 70f * density
    }

    /** How visible seed [i] is: it fades in when it starts and out as it nears the top of the sidebar. */
    internal fun seedAlpha(i: Int): Float = sFade[i] * (sy[i] / (0.15f * height)).coerceIn(0f, 1f)

    fun step(dt: Float) {
        if (!seeded) return
        time += dt
        val decay = 1f - min(1f, 6f * dt)
        touchVx *= decay
        touchVy *= decay

        // The phone's push on the loose things: the opposite way to how the phone accelerates.
        val windX = -shakeX
        val windY = shakeY
        val fade = 1f - min(1f, 8f * dt)
        shakeX *= fade
        shakeY *= fade

        stepBlades(dt, windX)
        stepSeeds(dt, windX, windY)
        stepLeaves(dt, windX)
    }

    private fun stepLeaves(dt: Float, windX: Float) {
        val reach = SEED_REACH_DP * density
        val reach2 = reach * reach
        for (i in 0 until leafCount) {
            if (lWait[i] > 0f) { lWait[i] -= dt; continue }
            lPhase[i] += lFreq[i] * dt
            var vx = cos(lPhase[i]) * lAmp[i] + tilt * 18f * density + windX * 4f * density
            if (touching) {
                val dx = lx[i] - tx
                val dy = ly[i] - ty
                val d2 = dx * dx + dy * dy
                if (d2 < reach2) vx += (if (dx >= 0f) 1f else -1f) * (1f - sqrt(d2) / reach) * 160f * density
            }
            lx[i] += vx * dt
            ly[i] += lFall[i] * dt
            lAng[i] += (lSpin[i] + sin(lPhase[i]) * 40f) * dt
            // Gone once it reaches the middle of the sidebar (or leaves it sideways): the next one waits a few seconds.
            if (ly[i] >= LEAF_END * height || lx[i] < -lSize[i] || lx[i] > width + lSize[i]) {
                initLeaf(i, 3f + rf() * 6f)
            }
        }
    }

    private fun stepBlades(dt: Float, windX: Float) {
        val reach = BLADE_REACH_DP * density
        val reach2 = reach * reach
        // How hard a moving finger drags the blades along (rad/s2).
        val drag = (touchVx / density * 0.05f).coerceIn(-60f, 60f)
        for (i in 0 until bladeCount) {
            val ambient = sin(time * 0.9f + bx[i] * 0.011f) * 0.55f + sin(time * 0.37f + bx[i] * 0.004f) * 0.45f
            val target = rest[i] + (tilt * 0.28f + ambient * 0.09f + windX * 0.011f) * bend[i]
            var acc = -SPRING_K * (th[i] - target) - SPRING_C * om[i] + windX * 0.35f * bend[i]
            if (touching) {
                val tipX = bx[i] + sin(th[i]) * bh[i]
                val tipY = height - cos(th[i]) * bh[i]
                val dx = tipX - tx
                val dy = tipY - ty
                val d2 = dx * dx + dy * dy
                if (d2 < reach2) {
                    val f = 1f - sqrt(d2) / reach
                    acc += ((if (dx >= 0f) 55f else -55f) + drag) * f
                }
            }
            om[i] += acc * dt
            var a = th[i] + om[i] * dt
            if (a > MAX_BEND) { a = MAX_BEND; om[i] *= 0.5f }
            else if (a < -MAX_BEND) { a = -MAX_BEND; om[i] *= 0.5f }
            th[i] = a
        }
    }

    private fun stepSeeds(dt: Float, windX: Float, windY: Float) {
        val reach = SEED_REACH_DP * density
        val reach2 = reach * reach
        val relax = min(1f, 1.4f * dt)
        val edge = 30f * density
        for (i in 0 until seedCount) {
            sPhase[i] += sFreq[i] * dt
            // The air carries the seed: it sways and rises. A push (finger, shake, puff) simply fades back into
            // this, so a blown seed arcs away and then floats on.
            svx[i] += (cos(sPhase[i]) * sAmp[i] + tilt * 24f * density - svx[i]) * relax
            svy[i] += (-sRise[i] - svy[i]) * relax
            svx[i] += windX * 70f * density * sWeight[i] * dt
            svy[i] += windY * 70f * density * sWeight[i] * dt

            if (touching) {
                val dx = sx[i] - tx
                val dy = sy[i] - ty
                val d2 = dx * dx + dy * dy
                if (d2 < reach2) {
                    val d = sqrt(d2) + 0.5f
                    val f = 1f - d / reach
                    svx[i] += (dx / d * 1500f * density + touchVx * 5f) * f * dt
                    svy[i] += (dy / d * 900f * density + touchVy * 5f) * f * dt
                }
            }

            sx[i] += svx[i] * dt
            sy[i] += svy[i] * dt
            sFade[i] = min(1f, sFade[i] + 0.8f * dt)
            sAng[i] = (svx[i] / density * 0.15f + sin(sPhase[i]) * 12f).coerceIn(-75f, 75f)

            if (sy[i] < -24f * density || sy[i] > height + 60f * density || sx[i] < -edge || sx[i] > width + edge) {
                respawnSeed(i)
            }
        }
    }

    /** A few seeds fly off the spot. They take the places of the seeds closest to leaving the top. */
    private fun puff(x: Float, y: Float) {
        if (seedCount == 0) return
        repeat(3) {
            var slot = 0
            for (i in 1 until seedCount) if (sy[i] < sy[slot]) slot = i
            initSeed(slot)
            sx[slot] = x + (rf() - 0.5f) * 10f * density
            sy[slot] = y
            svx[slot] = (rf() - 0.5f) * 160f * density
            svy[slot] = -(80f + rf() * 110f) * density
            sFade[slot] = 0.6f
        }
    }

    // ---- the phone ----

    /** Raw accelerometer reading (m/s2, device axes). Splits it into the tilt (slow) and the shake (fast). */
    fun onAccel(x: Float, y: Float, @Suppress("UNUSED_PARAMETER") z: Float) {
        if (!gInit) { gx = x; gy = y; gInit = true }
        gx += 0.04f * (x - gx)
        gy += 0.04f * (y - gy)
        val lx = x - gx
        val ly = y - gy
        if (sqrt(lx * lx + ly * ly) < SHAKE_DEADZONE) {
            shakeX = 0f
            shakeY = 0f
        } else {
            shakeX = lx.coerceIn(-35f, 35f)
            shakeY = ly.coerceIn(-35f, 35f)
        }
        // Right side down reads as a negative x.
        tilt += 0.1f * ((-gx / GRAVITY).coerceIn(-1f, 1f) - tilt)
    }

    // ---- the finger ----

    /** A fresh touch: a tap on the meadow puffs seeds off the nearest blade. */
    fun touchDown(at: Offset) {
        if (!animated || !seeded) return
        touching = true
        tx = at.x
        ty = at.y
        if (time - lastPuff < 0.25f) return
        val reach = BLADE_REACH_DP * 1.3f * density
        var best = -1
        var bestD2 = reach * reach
        for (i in 0 until bladeCount) {
            val dx = bx[i] + sin(th[i]) * bh[i] - at.x
            val dy = height - cos(th[i]) * bh[i] - at.y
            val d2 = dx * dx + dy * dy
            if (d2 < bestD2) { bestD2 = d2; best = i }
        }
        if (best >= 0) {
            lastPuff = time
            puff(bx[best] + sin(th[best]) * bh[best], height - cos(th[best]) * bh[best])
        }
    }

    /** A moving finger brushes through: [velocity] is in pixels per second. */
    fun touchMove(at: Offset, velocity: Offset) {
        if (!animated || !seeded) return
        touching = true
        tx = at.x
        ty = at.y
        val max = 1500f * density
        touchVx = (velocity.x * 0.6f + touchVx * 0.4f).coerceIn(-max, max)
        touchVy = (velocity.y * 0.6f + touchVy * 0.4f).coerceIn(-max, max)
    }

    fun touchUp() {
        touching = false
    }
}

/** Watches the finger without taking it: nothing is consumed, so taps, scrolls and the sidebar swipe still work. */
internal fun Modifier.leafBlow(field: LeafField): Modifier = pointerInput(field) {
    awaitPointerEventScope {
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            for (change in event.changes) {
                when {
                    change.changedToDown() -> field.touchDown(change.position)
                    change.pressed -> {
                        val ms = (change.uptimeMillis - change.previousUptimeMillis).coerceAtLeast(1L)
                        field.touchMove(change.position, (change.position - change.previousPosition) * (1000f / ms))
                    }
                    else -> field.touchUp()
                }
            }
        }
    }
}

/** Draws the meadow. Give it the size of the sidebar (for example `Modifier.matchParentSize()`). */
@Composable
internal fun LeafLayer(field: LeafField, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val density = LocalDensity.current.density
    val scheme = MaterialTheme.colorScheme

    // Settled once, before the first frame: fewer blades and seeds in battery saver, nothing moving if animations are off.
    remember(field) {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val saver = power?.isPowerSaveMode == true
        field.capacity = if (saver) LOW_POWER_BLADES else MAX_BLADES
        field.seedCapacity = if (saver) LOW_POWER_SEEDS else MAX_SEEDS
        field.leafCapacity = if (saver) LOW_POWER_LEAVES else MAX_LEAVES
        field.animated = Settings.Global.getFloat(
            context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f
        ) != 0f
        true
    }

    val colors = remember(scheme.primary, scheme.secondary, scheme.tertiary) {
        arrayOf(scheme.primary, scheme.secondary, scheme.tertiary)
    }

    // The sidebar sits off screen while it is closed (it slides in from the left): only animate while it shows.
    var onScreen by remember { mutableStateOf(false) }
    LaunchedEffect(onScreen) {
        if (!onScreen || !field.animated) return@LaunchedEffect
        var last = withFrameNanos { it }
        while (true) {
            val now = withFrameNanos { it }
            field.step(((now - last) / 1_000_000_000f).coerceAtMost(0.05f))
            last = now
            field.tick.longValue = now
        }
    }

    // Shake and tilt: listen to the accelerometer only while the sidebar shows. No permission is needed.
    DisposableEffect(onScreen) {
        val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val sensor = manager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                field.onAccel(event.values[0], event.values[1], event.values[2])
            }

            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
        }
        if (onScreen && field.animated && manager != null && sensor != null) {
            manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_GAME)
        }
        onDispose { manager?.unregisterListener(listener) }
    }

    Canvas(
        modifier.onGloballyPositioned {
            onScreen = it.positionInWindow().x + it.size.width > 1f
        }
    ) {
        field.resize(size.width, size.height, density)
        @Suppress("UNUSED_VARIABLE") val redrawOnTick = field.tick.longValue

        // Seeds first (behind), then the grass over them.
        for (i in 0 until field.seedCount) {
            val a = field.seedAlpha(i)
            if (a <= 0.01f) continue
            val s = field.sSize[i]
            val color = colors[field.sHue[i].toInt()].copy(alpha = 0.42f * a)
            val stalk = 12f * density
            val bristle = 8f * density
            val line = 1.1f * density / s
            withTransform({
                translate(field.sx[i], field.sy[i])
                rotate(field.sAng[i], Offset.Zero)
                scale(s, s, Offset.Zero)
            }) {
                drawLine(color, Offset.Zero, Offset(0f, -stalk), strokeWidth = line, cap = StrokeCap.Round)
                for (k in 0 until 5) {
                    drawLine(
                        color,
                        Offset(0f, -stalk),
                        Offset(BRISTLE_SIN[k] * bristle, -stalk - BRISTLE_COS[k] * bristle),
                        strokeWidth = line,
                        cap = StrokeCap.Round
                    )
                }
                drawCircle(color, radius = 1.7f * density, center = Offset.Zero)
            }
        }

        // The few falling leaves, over the seeds and under the grass.
        for (i in 0 until field.leafCount) {
            val a = field.leafAlpha(i)
            if (a <= 0.01f) continue
            val len = field.lSize[i]
            withTransform({
                translate(field.lx[i], field.ly[i])
                rotate(field.lAng[i], Offset.Zero)
                scale(len, len, Offset.Zero)
            }) {
                drawPath(field.leafShape, colors[field.lHue[i].toInt()].copy(alpha = 0.55f * a))
            }
        }

        val baseY = size.height + 2f * density
        val path = field.path
        for (i in 0 until field.bladeCount) {
            val h = field.bh[i]
            val a = field.th[i]
            val x0 = field.bx[i]
            val w = field.bw[i]
            val tipX = x0 + sin(a) * h
            val tipY = baseY - cos(a) * h
            // The blade bends more near its tip than at its foot.
            val mid = a * 0.35f
            val cx = x0 + sin(mid) * h * 0.55f
            val cy = baseY - cos(mid) * h * 0.55f
            path.rewind()
            path.moveTo(x0 - w, baseY)
            path.quadraticTo(cx - w * 0.5f, cy, tipX, tipY)
            path.quadraticTo(cx + w * 0.5f, cy, x0 + w, baseY)
            path.close()
            val isFlower = field.flower[i]
            drawPath(path, colors[field.bhue[i].toInt()].copy(alpha = if (isFlower) 0.30f else 0.32f))

            if (isFlower) {
                // Five petals around a center, riding the tip of the stem.
                val petals = colors[2].copy(alpha = 0.46f)
                val ring = 4.6f * density
                for (k in 0 until 5) {
                    val ang = a + k * 1.2566f
                    drawCircle(
                        petals,
                        radius = 3.1f * density,
                        center = Offset(tipX + sin(ang) * ring, tipY - cos(ang) * ring)
                    )
                }
                drawCircle(colors[1].copy(alpha = 0.62f), radius = 2.8f * density, center = Offset(tipX, tipY))
            }
        }
    }
}
