package com.plantellect.mobileplantellect.ui.screen

import android.os.Build
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.collectLatest
import kotlin.math.PI
import kotlin.math.sin

/*
 * Touch feedback for the whole app: a short vibration when a button is pressed, and a "no" buzz plus a
 * shake of the thing that is wrong (a text box that is full, a field with an error, an error message).
 *
 *  - Settings > Touch feedback turns all of it on or off (SettingsStore.hapticsEnabled). MainActivity feeds
 *    that value into [LocalHapticsEnabled]; every helper below reads it, so nothing else needs to know.
 *  - The phone's own "touch feedback / vibration" system setting still applies on top of ours.
 *
 * How to use it:
 *   Modifier.hapticClickable { ... }          instead of Modifier.clickable { ... }
 *   Modifier.hapticCombinedClickable(...)     instead of Modifier.combinedClickable(...)
 *   HapticIconButton / HapticFilterChip / HapticDropdownMenuItem   instead of the Material ones
 *   onClick = hapticClick { ... }             to wrap any other onClick that has no wrapper
 *   Modifier.shakeWhen(error)                 shakes the widget whenever [error] becomes (or changes to) non-null
 *   rememberShakeState() + Modifier.shake(s)  to shake on demand with s.shake()
 *
 * The PlantButton / PlantTonalButton / PlantOutlinedButton / PlantTextButton kit (PlantellectButtons.kt) and
 * PlantSurface(onClick) already do this.
 */

/** True when Settings > Touch feedback is on. Provided once, in MainActivity. */
val LocalHapticsEnabled = compositionLocalOf { true }

/** Last time the "rejected" buzz fired; stops a form with five errors (or fast typing) from buzzing nonstop. */
private var lastRejectAt = 0L
private const val REJECT_GAP_MS = 80L

@Stable
class Haptics internal constructor(private val view: View, private val enabled: Boolean) {

    /*
     * Every buzz goes straight to the phone's vibration motor at FULL strength (amplitude 255), because the
     * system's own touch-feedback effects are light and on many phones barely noticeable. Phones without
     * strength control get the same timing at their default strength; phones with no vibrator at all fall
     * back to the system effect.
     */

    /** A button, chip, row or tab was pressed. A short, firm thump. */
    fun tap() = buzz(longArrayOf(0, 35), HapticFeedbackConstants.VIRTUAL_KEY)

    /** A switch, checkbox or radio button changed. Slightly longer than a tap so on/off is felt clearly. */
    fun toggle(on: Boolean) = buzz(
        if (on) longArrayOf(0, 45) else longArrayOf(0, 30, 30, 30),
        if (Build.VERSION.SDK_INT >= 34) {
            if (on) HapticFeedbackConstants.TOGGLE_ON else HapticFeedbackConstants.TOGGLE_OFF
        } else HapticFeedbackConstants.CONTEXT_CLICK
    )

    fun longPress() = buzz(longArrayOf(0, 80), HapticFeedbackConstants.LONG_PRESS)

    /** The camera shutter: the strongest one. A hard hit, a tiny gap, then a follow-up thump. */
    fun shutter() = buzz(longArrayOf(0, 90, 30, 60), HapticFeedbackConstants.LONG_PRESS)

    /** Something was refused or is wrong (typing past a limit, a field with an error): two hard pulses. */
    fun reject() {
        val now = SystemClock.uptimeMillis()
        if (now - lastRejectAt < REJECT_GAP_MS) return
        lastRejectAt = now
        buzz(longArrayOf(0, 60, 50, 60), HapticFeedbackConstants.REJECT)
    }

    /**
     * [timings] is the pattern in milliseconds: wait, buzz, wait, buzz... Every buzz entry runs at full strength.
     * [fallback] is the system effect used when there is no vibrator to talk to.
     */
    private fun buzz(timings: LongArray, fallback: Int) {
        if (!enabled) return
        val vibrator = runCatching {
            (view.context.getSystemService(android.content.Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        }.getOrNull()
        if (vibrator == null || !vibrator.hasVibrator()) { view.performHapticFeedback(fallback); return }
        val effect = runCatching {
            if (vibrator.hasAmplitudeControl()) {
                // Even positions are pauses (0), odd positions are buzzes (255 = full strength).
                val amps = IntArray(timings.size) { i -> if (i % 2 == 0) 0 else 255 }
                VibrationEffect.createWaveform(timings, amps, -1)
            } else VibrationEffect.createWaveform(timings, -1)
        }.getOrNull()
        if (effect == null) { view.performHapticFeedback(fallback); return }
        runCatching { vibrator.vibrate(effect) }.onFailure { view.performHapticFeedback(fallback) }
    }
}

/**
 * The haptics for the place this is called from. The view is taken here (not once at the top) so a vibration
 * asked for inside a dialog goes through the dialog's own window. [force] ignores the Settings switch; it is
 * only for the "you just turned it on" buzz in Settings itself.
 */
@Composable
fun rememberHaptics(force: Boolean = false): Haptics {
    val view = LocalView.current
    val on = LocalHapticsEnabled.current || force
    return remember(view, on) { Haptics(view, on) }
}

/** [onClick] with a tap buzz in front of it. */
@Composable
internal fun hapticClick(onClick: () -> Unit): () -> Unit {
    val haptics = rememberHaptics()
    return { haptics.tap(); onClick() }
}

/** [onChange] with an on/off buzz in front of it (switches, checkboxes). */
@Composable
internal fun hapticToggle(onChange: (Boolean) -> Unit): (Boolean) -> Unit {
    val haptics = rememberHaptics()
    return { on -> haptics.toggle(on); onChange(on) }
}

/** Drop-in for [clickable]: same arguments, plus a tap buzz. */
internal fun Modifier.hapticClickable(
    enabled: Boolean = true,
    onClickLabel: String? = null,
    role: Role? = null,
    onClick: () -> Unit
): Modifier = composed {
    val haptics = rememberHaptics()
    clickable(enabled = enabled, onClickLabel = onClickLabel, role = role) { haptics.tap(); onClick() }
}

/** Drop-in for [combinedClickable]: a tap buzz on click and a stronger one on long press. */
@OptIn(ExperimentalFoundationApi::class)
internal fun Modifier.hapticCombinedClickable(
    enabled: Boolean = true,
    onClickLabel: String? = null,
    role: Role? = null,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit
): Modifier = composed {
    val haptics = rememberHaptics()
    combinedClickable(
        enabled = enabled, onClickLabel = onClickLabel, role = role,
        onLongClick = onLongClick?.let { long -> { haptics.longPress(); long() } },
        onClick = { haptics.tap(); onClick() }
    )
}

@Composable
internal fun HapticIconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable () -> Unit
) {
    IconButton(onClick = hapticClick(onClick), modifier = modifier, enabled = enabled, content = content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HapticFilterChip(
    selected: Boolean,
    onClick: () -> Unit,
    label: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    FilterChip(selected = selected, onClick = hapticClick(onClick), label = label, modifier = modifier, enabled = enabled)
}

@Composable
internal fun HapticDropdownMenuItem(
    text: @Composable () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    DropdownMenuItem(text = text, onClick = hapticClick(onClick), modifier = modifier, enabled = enabled)
}

// ---------------------------------------------------------------------------
// Shake: the thing that is wrong wiggles left and right
// ---------------------------------------------------------------------------

private const val SHAKE_MS = 450
private const val SHAKE_CYCLES = 3f

@Stable
class ShakeState {
    /** 0 = at rest, runs to 1 while shaking. */
    internal val progress = Animatable(1f)
    internal var tick by mutableStateOf(0)

    /** Start shaking. Calling it again while it shakes starts over, so repeated mistakes keep it shaking. */
    fun shake() { tick++ }
}

@Composable
fun rememberShakeState(): ShakeState {
    val state = remember { ShakeState() }
    LaunchedEffect(state) {
        // collectLatest drops the shake in progress when a new one is asked for: it restarts instead of stacking.
        snapshotFlow { state.tick }.collectLatest { t ->
            if (t > 0) {
                state.progress.snapTo(0f)
                state.progress.animateTo(1f, tween(SHAKE_MS, easing = LinearEasing))
            }
        }
    }
    return state
}

/** Moves the widget sideways while [state] is shaking (a fading wiggle). Draws only: layout does not change. */
fun Modifier.shake(state: ShakeState, amplitude: Dp = 8.dp): Modifier = graphicsLayer {
    val p = state.progress.value
    translationX = if (p <= 0f || p >= 1f) 0f
    else sin(p * 2f * PI.toFloat() * SHAKE_CYCLES) * (1f - p) * amplitude.toPx()
}

/**
 * Shakes this widget (with a "no" buzz) whenever [trigger] becomes non-null or changes to another non-null value,
 * for example an error message. [retrigger] is for "the same error again": when it changes while [trigger] is
 * still non-null, it shakes again (a form uses its submit counter here).
 */
@Composable
fun Modifier.shakeWhen(trigger: Any?, retrigger: Any? = null): Modifier {
    val state = rememberShakeState()
    val haptics = rememberHaptics()
    LaunchedEffect(trigger, retrigger) {
        if (trigger != null) {
            state.shake()
            haptics.reject()
        }
    }
    return this.shake(state)
}
