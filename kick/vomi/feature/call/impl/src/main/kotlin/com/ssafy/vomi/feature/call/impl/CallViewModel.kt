package com.ssafy.vomi.feature.call.impl

import androidx.lifecycle.ViewModel
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.feature.call.impl.model.CallPhase
import com.ssafy.vomi.feature.call.impl.model.CallUiState
import com.ssafy.vomi.feature.call.impl.model.sampleCallState
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

@HiltViewModel
internal class CallViewModel @Inject constructor() : ViewModel() {
    private val _uiState = MutableStateFlow(CallUiState())
    val uiState = _uiState.asStateFlow()
    private var initialized = false

    fun initialize(friendId: Long, friendName: String, isIncoming: Boolean) {
        if (initialized) return
        initialized = true
        _uiState.value = sampleCallState(friendId, friendName, isIncoming)
    }

    fun tick() {
        _uiState.update { if (it.phase == CallPhase.Active) it.copy(elapsedSeconds = it.elapsedSeconds + 1) else it }
    }

    fun toggleMicrophone() {
        _uiState.update { if (it.phase == CallPhase.Active) it.copy(isMicrophoneEnabled = !it.isMicrophoneEnabled) else it }
    }

    fun updateDraft(text: String) {
        _uiState.update { if (it.canType) it.copy(draft = text) else it }
    }

    fun sendSuggestion(id: Long) {
        _uiState.update { state ->
            val suggestion = state.suggestions.find { it.id == id }
            if (state.canType && suggestion != null) state.appendLocalMessage(suggestion.text) else state
        }
    }

    fun selectSuggestion(id: Long) {
        _uiState.update { state ->
            val suggestion = state.suggestions.find { it.id == id }
            if (state.canType && suggestion != null) state.copy(draft = suggestion.text) else state
        }
    }

    fun sendDraft() {
        _uiState.update { state ->
            if (state.canSend) state.appendLocalMessage(state.draft.trim()).copy(draft = "") else state
        }
    }

    fun selectBackchannel(id: Long) {
        _uiState.update { state ->
            val backchannel = state.backchannels.find { it.id == id }
            if (state.canType && backchannel != null) state.appendLocalMessage(backchannel.text) else state
        }
    }

    fun showSummary() { _uiState.update { if (it.phase == CallPhase.Active) it.copy(isSummaryVisible = true) else it } }
    fun dismissSummary() { _uiState.update { it.copy(isSummaryVisible = false) } }

    fun acceptIncoming() {
        _uiState.update {
            if (it.phase == CallPhase.Incoming) sampleCallState(it.friendId, it.friendName) else it
        }
    }

    fun endCall() {
        _uiState.update { it.copy(phase = CallPhase.Ended, isMicrophoneEnabled = false, isSummaryVisible = false) }
    }

    private fun CallUiState.appendLocalMessage(text: String): CallUiState = copy(
        messages = messages + CallMessage((messages.maxOfOrNull { it.id } ?: 0L) + 1L, CallSpeaker.Local, text),
    )
}
