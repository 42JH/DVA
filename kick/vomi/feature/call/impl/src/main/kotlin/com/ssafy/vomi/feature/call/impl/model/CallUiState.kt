package com.ssafy.vomi.feature.call.impl.model

import com.ssafy.vomi.core.model.call.Backchannel
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.CallSummary
import com.ssafy.vomi.core.model.call.ReplySuggestion

internal enum class CallPhase { Incoming, Active, Ended }

internal data class CallUiState(
    val friendId: String = "",
    val friendName: String = "",
    val phase: CallPhase = CallPhase.Active,
    val elapsedSeconds: Long = 0L,
    val isMicrophoneEnabled: Boolean = false,
    val draft: String = "",
    val messages: List<CallMessage> = emptyList(),
    val suggestions: List<ReplySuggestion> = emptyList(),
    val backchannels: List<Backchannel> = emptyList(),
    val summary: CallSummary? = null,
    val isSummaryVisible: Boolean = false,
) {
    val canType: Boolean get() = phase == CallPhase.Active && !isMicrophoneEnabled
    val canSend: Boolean get() = canType && draft.isNotBlank()
}
