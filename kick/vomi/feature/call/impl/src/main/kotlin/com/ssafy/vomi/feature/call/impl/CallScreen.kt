package com.ssafy.vomi.feature.call.impl

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ssafy.vomi.core.designsystem.component.Scaffold
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

@Composable
internal fun CallScreen(
    friendId: Long,
    friendName: String,
    isIncoming: Boolean,
    onEndCall: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: CallViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    LaunchedEffect(friendId, friendName, isIncoming) {
        viewModel.initialize(
            friendId,
            friendName,
            isIncoming
        )
    }
    LaunchedEffect(state.phase) {
        if (state.phase == CallPhase.Ended) onEndCall()
        if (state.phase == CallPhase.Active) {
            while (isActive) {
                delay(1_000L)
                viewModel.tick()
            }
        }
    }
    BackHandler(onBack = viewModel::endCall)
    CallContent(
        state = state,
        onMicrophoneClick = viewModel::toggleMicrophone,
        onDraftChange = viewModel::updateDraft,
        onSendClick = viewModel::sendDraft,
        onSummaryClick = viewModel::showSummary,
        onSummaryDismiss = viewModel::dismissSummary,
        onEndClick = viewModel::endCall,
        onSuggestionClick = viewModel::selectSuggestion,
        onBackchannelClick = viewModel::selectBackchannel,
        onAcceptClick = viewModel::acceptIncoming,
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
    onBackchannelClick: (Long) -> Unit,
    onAcceptClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier.fillMaxSize()) {
        if (state.phase == CallPhase.Incoming) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 14.dp, vertical = 24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = stringResource(R.string.call_preview),
                    style = VomiTheme.typography.captionR12,
                    color = VomiTheme.colors.gray400
                )
                IncomingCallBanner(
                    name = state.friendName,
                    onAccept = onAcceptClick,
                    onDecline = onEndClick
                )
            }
        } else {
            Column(modifier = Modifier.fillMaxSize()) {
                CallHeader(
                    name = state.friendName,
                    elapsedSeconds = state.elapsedSeconds,
                    onSummaryClick = onSummaryClick,
                    onEndClick = onEndClick
                )
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
                    onBackchannelClick = onBackchannelClick
                )
                CallInput(
                    state = state,
                    onDraftChange = onDraftChange,
                    onMicrophoneClick = onMicrophoneClick,
                    onSendClick = onSendClick
                )
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
    CallPreview(sampleCallState(1L, "싸피 야옹").copy(elapsedSeconds = 2))
}

@Preview(name = "Microphone on", widthDp = 393, heightDp = 800)
@Composable
private fun MicrophoneOnPreview() {
    CallPreview(sampleCallState(1L, "싸피 야옹").copy(isMicrophoneEnabled = true))
}


@Preview(name = "Summary", widthDp = 393, heightDp = 800)
@Composable
private fun SummaryPreview() {
    CallPreview(sampleCallState(1L, "싸피 야옹").copy(isSummaryVisible = true))
}

@Preview(name = "Incoming call", widthDp = 393, heightDp = 800)
@Composable
private fun IncomingCallPreview() {
    CallPreview(sampleCallState(1L, "싸피 야옹", isIncoming = true))
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
