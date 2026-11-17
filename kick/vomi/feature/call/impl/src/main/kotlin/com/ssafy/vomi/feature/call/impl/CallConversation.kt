package com.ssafy.vomi.feature.call.impl

import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.feature.call.impl.model.CallPhase
import com.ssafy.vomi.feature.call.impl.model.CallUiState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Local composition rules, enabled once the media layer reports an active call. */
internal class CallConversation(private val mutableState: MutableStateFlow<CallUiState>) {
    val uiState = mutableState.asStateFlow()
    fun tick() {
        mutableState.update { if (it.phase == CallPhase.Active) it.copy(elapsedSeconds = it.elapsedSeconds + 1) else it }
    }

    fun toggleMicrophone() {
        mutableState.update { if (it.phase == CallPhase.Active) it.copy(isMicrophoneEnabled = !it.isMicrophoneEnabled) else it }
    }

    fun updateDraft(text: String) {
        mutableState.update { if (it.canType) it.copy(draft = text) else it }
    }

    fun sendSuggestion(id: Long) {
        mutableState.update { state ->
            val suggestion = state.suggestions.find { it.id == id }
            if (state.canSendTextAudio && suggestion != null) state.appendLocalMessage(suggestion.text) else state
        }
    }

    fun selectSuggestion(id: Long) {
        mutableState.update { state ->
            val suggestion = state.suggestions.find { it.id == id }
            if (state.canType && suggestion != null) state.copy(draft = suggestion.text) else state
        }
    }

    fun sendDraft() {
        mutableState.update { state ->
            if (state.canSend) state.appendLocalMessage(state.draft.trim()).copy(draft = "") else state
        }
    }

    fun selectBackchannel(id: Long) {
        mutableState.update { state ->
            val backchannel = state.backchannels.find { it.id == id }
            if (state.canSendTextAudio && backchannel != null) state.appendLocalMessage(backchannel.text) else state
        }
    }

    fun showSummary() { mutableState.update { if (it.phase == CallPhase.Active) it.copy(isSummaryVisible = true) else it } }
    fun dismissSummary() { mutableState.update { it.copy(isSummaryVisible = false) } }

    private fun CallUiState.appendLocalMessage(text: String): CallUiState = copy(
        messages = messages + CallMessage((messages.maxOfOrNull { it.id } ?: 0L) + 1L, CallSpeaker.Local, text),
    )
}
