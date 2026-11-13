package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.layout.onGloballyPositioned

/** Locks only a vertical drag, so the containing LazyRow retains horizontal scrolling. */
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
    return onGloballyPositioned { origin = it.positionInRoot() }
        .pointerInput(id, enabled) {
            if (!enabled) return@pointerInput
            var draggingDown = false
            detectVerticalDragGestures(
                onDragStart = { draggingDown = false },
                onVerticalDrag = { change, amount ->
                    if (!draggingDown && amount > 0f) {
                        draggingDown = true
                        currentStart(id, origin + change.position)
                    } else if (draggingDown) {
                        currentMove(origin + change.position)
                    }
                    // Consumed movement cancels the chip's click; releasing a drag never sends it.
                    change.consume()
                },
                onDragEnd = {
                    if (draggingDown) currentEnd()
                    draggingDown = false
                },
                onDragCancel = {
                    if (draggingDown) currentCancel()
                    draggingDown = false
                },
            )
        }
}
