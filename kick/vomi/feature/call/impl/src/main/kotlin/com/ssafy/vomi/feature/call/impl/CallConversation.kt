package com.ssafy.vomi.feature.call.impl

import com.ssafy.vomi.feature.call.impl.model.CallPhase
import com.ssafy.vomi.feature.call.impl.model.CallUiState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Draft/selection UI rules. Only the Repository records actual message delivery. */
internal class CallConversation(private val mutableState: MutableStateFlow<CallUiState>) {
    val uiState = mutableState.asStateFlow()

    fun updateDraft(text: String) {
        mutableState.update { if (it.canType) it.copy(draft = text) else it }
    }

    fun suggestionToSend(id: Long): String? = mutableState.value.let { state ->
        state.suggestions.find { it.id == id }?.takeIf { state.canType && it.isComplete }?.text
    }

    fun selectSuggestion(id: Long) {
        mutableState.update { state ->
            val suggestion = state.suggestions.find { it.id == id }
            if (state.canType && suggestion?.isComplete == true) state.copy(draft = suggestion.text) else state
        }
    }

    fun draftToSend(): String? = mutableState.value.let { state ->
        state.draft.trim().takeIf { state.canSend }
    }

    fun backchannelToSend(id: Long): String? = mutableState.value.let { state ->
        state.backchannels.find { it.id == id }?.text?.takeIf { state.canType }
    }

    fun showSummary() { mutableState.update { if (it.phase == CallPhase.Active) it.copy(isSummaryVisible = true) else it } }
    fun dismissSummary() { mutableState.update { it.copy(isSummaryVisible = false) } }
}
