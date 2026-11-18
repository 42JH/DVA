package com.ssafy.vomi.feature.call.impl.model

import com.ssafy.vomi.core.model.call.CallTextPlaybackStatus
import com.ssafy.vomi.core.model.call.CallTextError
import com.ssafy.vomi.core.model.call.CallTextRequest
import com.ssafy.vomi.core.model.ai.ReplyModelState
import com.ssafy.vomi.core.model.ai.ReplyRecommendationError
import com.ssafy.vomi.core.model.speech.SpeechState
import com.ssafy.vomi.core.model.call.CallMediaConnection
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.Backchannel
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.CallSummary
import com.ssafy.vomi.core.model.call.ReplySuggestion

internal enum class CallPhase { Connecting, Outgoing, Incoming, Accepted, Active, Ended }

internal data class CallUiState(
    val callId: String = "",
    val connection: CallConnection = CallConnection.Connecting,
    val isActionPending: Boolean = false,
    val isCreating: Boolean = false,
    val hasActionError: Boolean = false,
    val friendId: String = "",
    val friendName: String = "",
    val phase: CallPhase = CallPhase.Connecting,
    val elapsedSeconds: Long = 0L,
    val isMicrophoneEnabled: Boolean = false,
    val isMicrophonePending: Boolean = false,
    val hasMicrophoneError: Boolean = false,
    val isMicrophonePermissionDenied: Boolean = false,
    val mediaConnection: CallMediaConnection = CallMediaConnection.Disconnected,
    val isSendingText: Boolean = false,
    val textSendError: CallTextError? = null,
    val failedTextRequest: CallTextRequest? = null,
    val hasPlaybackError: Boolean = false,
    val draft: String = "",
    val messages: List<CallMessage> = emptyList(),
    val speech: SpeechState = SpeechState(),
    val suggestions: List<ReplySuggestion> = emptyList(),
    val replyModel: ReplyModelState = ReplyModelState(),
    val isReplyModelOperationPending: Boolean = false,
    val replyModelError: ReplyRecommendationError? = null,
    val isGeneratingReplies: Boolean = false,
    val replyGenerationError: ReplyRecommendationError? = null,
    val suggestionSourceMessageId: Long? = null,
    val backchannels: List<Backchannel> = emptyList(),
    val summary: CallSummary? = null,
    val isSummaryVisible: Boolean = false,
) {
    val hasPendingTextPlayback: Boolean get() = messages.any {
        it.playback?.status == CallTextPlaybackStatus.Queued || it.playback?.status == CallTextPlaybackStatus.Playing
    }
    val canType: Boolean get() = phase == CallPhase.Active && !isMicrophoneEnabled && !isMicrophonePending && !isActionPending && !isCreating && !isSendingText
    val canSend: Boolean get() = canType && draft.isNotBlank()
    val canToggleMicrophone: Boolean get() = (phase == CallPhase.Active || phase == CallPhase.Accepted) &&
        mediaConnection == CallMediaConnection.Connected &&
        !isActionPending && !isCreating && !isMicrophonePending && !isSendingText
}
