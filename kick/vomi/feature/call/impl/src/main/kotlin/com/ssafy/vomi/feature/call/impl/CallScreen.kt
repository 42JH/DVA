package com.ssafy.vomi.feature.call.impl

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ssafy.vomi.core.designsystem.component.Button
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.designsystem.component.LoadingWheel
import com.ssafy.vomi.core.designsystem.component.Scaffold
import com.ssafy.vomi.core.designsystem.component.Surface
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.component.VomiBackground
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.feature.call.impl.component.CallHeader
import com.ssafy.vomi.feature.call.impl.component.CallInput
import com.ssafy.vomi.feature.call.impl.component.CallQuickReplies
import com.ssafy.vomi.feature.call.impl.component.CallSummarySheet
import com.ssafy.vomi.feature.call.impl.component.IncomingCallBanner
import com.ssafy.vomi.feature.call.impl.model.CallPhase
import com.ssafy.vomi.feature.call.impl.model.CallUiState
import com.ssafy.vomi.feature.call.impl.model.sampleCallState
import kotlin.math.roundToInt

@Composable
internal fun CallScreen(
    callId: String,
    modifier: Modifier = Modifier,
    viewModel: CallViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    LaunchedEffect(callId) { viewModel.initialize(callId) }
    BackHandler(onBack = viewModel::endCall)
    CallContent(
        state = state,
        onMicrophoneClick = viewModel::toggleMicrophone,
        onDraftChange = viewModel::updateDraft,
        onSendClick = viewModel::sendDraft,
        onSummaryClick = viewModel::showSummary,
        onSummaryDismiss = viewModel::dismissSummary,
        onEndClick = viewModel::endCall,
        onSuggestionClick = viewModel::sendSuggestion,
        onSuggestionEdit = viewModel::selectSuggestion,
        onBackchannelClick = viewModel::selectBackchannel,
        onAcceptClick = viewModel::acceptIncoming,
        onRetryConnection = viewModel::retryConnection,
        modifier = modifier,
    )
}

@Composable
private fun CallContent(
    state: CallUiState,
    onMicrophoneClick: () -> Unit,
    onDraftChange: (String) -> Unit,
    onSendClick: () -> Unit,
    onSummaryClick: () -> Unit,
    onSummaryDismiss: () -> Unit,
    onEndClick: () -> Unit,
    onSuggestionClick: (Long) -> Unit,
    onSuggestionEdit: (Long) -> Unit,
    onBackchannelClick: (Long) -> Unit,
    onAcceptClick: () -> Unit,
    modifier: Modifier = Modifier,
    onRetryConnection: () -> Unit = {},
) {
    var inputBounds by remember { mutableStateOf(Rect.Zero) }
    var contentOrigin by remember { mutableStateOf(Offset.Zero) }
    var contentWidth by remember { mutableIntStateOf(0) }
    var ghostSize by remember { mutableStateOf(IntSize.Zero) }
    var draggedSuggestion by remember { mutableStateOf<DraggedSuggestion?>(null) }
    var inputFocusRequest by remember { mutableIntStateOf(0) }
    LaunchedEffect(state.canType, state.isSummaryVisible) {
        if (!state.canType || state.isSummaryVisible) draggedSuggestion = null
    }
    Box(modifier = modifier
        .fillMaxSize()
        .onGloballyPositioned {
            contentOrigin = it.boundsInRoot().topLeft
            contentWidth = it.size.width
        }) {
        if (state.phase == CallPhase.Connecting) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingWheel() }
        } else if (state.phase == CallPhase.Incoming) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 14.dp, vertical = 24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (state.isActionPending) Text(
                    text = stringResource(R.string.call_action_pending),
                    style = VomiTheme.typography.captionR12,
                    color = VomiTheme.colors.gray400
                )
                IncomingCallBanner(
                    name = state.friendName,
                    onAccept = onAcceptClick,
                    enabled = !state.isActionPending && !state.isCreating,
                    onDecline = onEndClick
                )
                if (state.hasActionError) Text(stringResource(R.string.call_action_error))
            }
        } else {
            Column(modifier = Modifier.fillMaxSize()) {
                CallHeader(
                    name = state.friendName,
                    elapsedSeconds = state.elapsedSeconds,
                    onSummaryClick = onSummaryClick,
                    onEndClick = onEndClick,
                    enabled = !state.isActionPending && !state.isCreating,
                    summaryEnabled = state.phase == CallPhase.Active,
                )
                if (state.phase == CallPhase.Outgoing || state.phase == CallPhase.Accepted) {
                    Text(
                        text = stringResource(if (state.phase == CallPhase.Outgoing) R.string.call_outgoing else R.string.call_accepted),
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
                        style = VomiTheme.typography.bodyR16,
                    )
                }
                if (state.isActionPending || state.isCreating) Text(stringResource(R.string.call_action_pending), modifier = Modifier.padding(horizontal = 20.dp))
                if (state.hasActionError) Text(stringResource(R.string.call_action_error), modifier = Modifier.padding(horizontal = 20.dp))
                val listState = rememberLazyListState()
                LaunchedEffect(state.messages.size) {
                    if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
                }
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    items(state.messages, key = { it.id }) { message ->
                        val isLocal = message.speaker == CallSpeaker.Local
                        Box(
                            modifier = Modifier.fillMaxWidth(),
                            contentAlignment = if (isLocal) Alignment.CenterEnd else Alignment.CenterStart
                        ) {
                            Text(
                                text = message.text,
                                color = if (isLocal) Color(0xFFB9D7FA) else Color(0xFFF8F7FA),
                                style = VomiTheme.typography.bodyR16,
                                textAlign = if (isLocal) TextAlign.End else TextAlign.Start,
                                modifier = Modifier.widthIn(max = 520.dp),
                            )
                        }
                    }
                }
                CallQuickReplies(
                    state = state,
                    onSuggestionClick = onSuggestionClick,
                    onSuggestionEdit = { id ->
                        onSuggestionEdit(id)
                        inputFocusRequest++
                    },
                    onSuggestionDragStart = { id, position ->
                        if (state.canType) {
                            state.suggestions.find { it.id == id }?.let {
                                draggedSuggestion = DraggedSuggestion(id, it.text, position)
                            }
                        }
                    },
                    onSuggestionDragMove = { position ->
                        draggedSuggestion = draggedSuggestion?.copy(position = position)
                    },
                    onSuggestionDragEnd = {
                        val drag = draggedSuggestion
                        if (state.canType && drag != null && inputBounds.contains(drag.position)) {
                            onSuggestionEdit(drag.id)
                            inputFocusRequest++
                        }
                        draggedSuggestion = null
                    },
                    onSuggestionDragCancel = { draggedSuggestion = null },
                    onBackchannelClick = onBackchannelClick
                )
                CallInput(
                    state = state,
                    onDraftChange = onDraftChange,
                    onMicrophoneClick = onMicrophoneClick,
                    onSendClick = onSendClick,
                    onInputBoundsChanged = { inputBounds = it },
                    isDropTargetActive = draggedSuggestion != null && state.canType,
                    focusRequest = inputFocusRequest,
                )
            }
        }
        draggedSuggestion?.let { drag ->
            val ghostGap = with(LocalDensity.current) { 12.dp.toPx() }
            Surface(
                modifier = Modifier
                    .offset {
                        IntOffset(
                            (drag.position.x - contentOrigin.x - ghostSize.width / 2f)
                                .coerceIn(
                                    0f,
                                    (contentWidth - ghostSize.width).coerceAtLeast(0).toFloat()
                                )
                                .roundToInt(),
                            (drag.position.y - contentOrigin.y - ghostSize.height - ghostGap).coerceAtLeast(
                                0f
                            ).roundToInt(),
                        )
                    }
                    .widthIn(max = 220.dp)
                    .onSizeChanged { ghostSize = it },
                shape = RoundedCornerShape(12.dp),
                color = Color(0xFF53657B),
            ) {
                Text(
                    text = drag.text,
                    style = VomiTheme.typography.bodySB14,
                    maxLines = 2,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }
        if (state.connection == CallConnection.Failed && state.phase != CallPhase.Ended) {
            Column(modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp)) {
                Text(stringResource(R.string.call_connection_failed))
                Button(onClick = onRetryConnection) { Text(stringResource(R.string.call_retry_connection)) }
            }
        }
        if (state.isSummaryVisible) CallSummarySheet(
            summary = state.summary,
            onDismiss = onSummaryDismiss
        )
    }
}

@Preview(name = "Screening", widthDp = 393, heightDp = 800)
@Preview(name = "Screening - large text", widthDp = 393, heightDp = 800, fontScale = 1.5f)
@Preview(name = "Screening - compact phone", widthDp = 360, heightDp = 720)
@Preview(name = "Screening - reduced viewport", widthDp = 393, heightDp = 440)
@Composable
private fun CallScreenPreview() {
    CallPreview(sampleCallState("kick-test-2", "싸피 야옹").copy(elapsedSeconds = 2))
}

@Preview(name = "Microphone on", widthDp = 393, heightDp = 800)
@Composable
private fun MicrophoneOnPreview() {
    CallPreview(sampleCallState("kick-test-2", "싸피 야옹").copy(isMicrophoneEnabled = true))
}


@Preview(name = "Summary", widthDp = 393, heightDp = 800)
@Composable
private fun SummaryPreview() {
    CallPreview(sampleCallState("kick-test-2", "싸피 야옹").copy(isSummaryVisible = true))
}

@Preview(name = "Incoming call", widthDp = 393, heightDp = 800)
@Composable
private fun IncomingCallPreview() {
    CallPreview(sampleCallState("kick-test-2", "싸피 야옹", isIncoming = true))
}

@Composable
private fun CallPreview(state: CallUiState) {
    VomiTheme {
        VomiBackground {
            Scaffold(modifier = Modifier.fillMaxSize()) { padding ->
                CallContent(
                    state = state,
                    onMicrophoneClick = {},
                    onDraftChange = {},
                    onSendClick = {},
                    onSummaryClick = {},
                    onSummaryDismiss = {},
                    onEndClick = {},
                    onSuggestionClick = {},
                    onSuggestionEdit = {},
                    onBackchannelClick = {},
                    onAcceptClick = {},
                    modifier = Modifier
                        .padding(padding)
                        .consumeWindowInsets(padding),
                )
            }
        }
    }
}

private data class DraggedSuggestion(val id: Long, val text: String, val position: Offset)
