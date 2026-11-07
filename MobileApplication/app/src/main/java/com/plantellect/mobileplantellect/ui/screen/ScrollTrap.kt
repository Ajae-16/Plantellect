package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.ScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.unit.Velocity

/**
 * Keeps a scroll that starts INSIDE a scrolling box from leaking into the page around it.
 *
 * Put this modifier on the box (or on a parent of the scrolling column) and give it the same [state] the inner
 * `verticalScroll` uses. When the inner list reaches its top or bottom, the rest of the drag or fling used to be
 * handed to the page behind it, so the whole page started to move. Here that leftover is swallowed instead.
 *
 * A box whose content is shorter than its window cannot scroll at all; then nothing is swallowed, so a finger
 * resting on it still scrolls the page as usual.
 */
@Composable
internal fun Modifier.trapScroll(state: ScrollState): Modifier {
    val connection = remember(state) {
        object : NestedScrollConnection {
            // Whatever the inner list could not use (it is at its top or bottom) is taken here, so the page never sees it.
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset =
                if (state.maxValue > 0) available else Offset.Zero

            override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity =
                if (state.maxValue > 0) available else Velocity.Zero
        }
    }
    return this.nestedScroll(connection)
}
