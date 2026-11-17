package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitVerticalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.verticalDrag
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot

/** Downward drags edit the reply; upward drags remain available to the surrounding conversation list. */
@Composable
internal fun Modifier.suggestionDragSource(
    id: Long,
    enabled: Boolean,
    onStart: (Long, Offset) -> Unit,
    onMove: (Offset) -> Unit,
    onEnd: () -> Unit,
    onCancel: () -> Unit,
): Modifier {
    var origin by remember { mutableStateOf(Offset.Zero) }
    val currentStart by rememberUpdatedState(onStart)
    val currentMove by rememberUpdatedState(onMove)
    val currentEnd by rememberUpdatedState(onEnd)
    val currentCancel by rememberUpdatedState(onCancel)
    return onGloballyPositioned { origin = it.positionInRoot() }.pointerInput(id, enabled) {
        if (!enabled) return@pointerInput
        awaitEachGesture {
            var dragging = false
            try {
                val down = awaitFirstDown(requireUnconsumed = false)
                val drag = awaitVerticalTouchSlopOrCancellation(down.id) { change, overSlop ->
                    if (overSlop > 0f) {
                        change.consume()
                        dragging = true
                        currentStart(id, origin + change.position)
                    }
                } ?: return@awaitEachGesture
                val ended = verticalDrag(drag.id) { change ->
                    change.consume()
                    currentMove(origin + change.position)
                }
                dragging = false
                if (ended) currentEnd() else currentCancel()
            } finally {
                if (dragging) currentCancel()
            }
        }
    }
}
