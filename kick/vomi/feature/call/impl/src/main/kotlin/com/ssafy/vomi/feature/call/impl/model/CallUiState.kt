package com.ssafy.vomi.feature.call.impl.model

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
    val isTextAudioAvailable: Boolean = false,
    val draft: String = "",
    val messages: List<CallMessage> = emptyList(),
    val suggestions: List<ReplySuggestion> = emptyList(),
    val backchannels: List<Backchannel> = emptyList(),
    val summary: CallSummary? = null,
    val isSummaryVisible: Boolean = false,
) {
    val canType: Boolean get() = phase == CallPhase.Active && !isMicrophoneEnabled && !isMicrophonePending && !isActionPending && !isCreating
    val canSendTextAudio: Boolean get() = canType && isTextAudioAvailable
    val canSend: Boolean get() = canSendTextAudio && draft.isNotBlank()
    val canToggleMicrophone: Boolean get() = (phase == CallPhase.Active || phase == CallPhase.Accepted) &&
        mediaConnection == CallMediaConnection.Connected &&
        !isActionPending && !isCreating && !isMicrophonePending
}
