package com.ssafy.vomi.feature.call.impl

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ssafy.vomi.core.common.result.Result
import com.ssafy.vomi.core.common.result.asResult
import com.ssafy.vomi.core.data.repository.CallRepository
import com.ssafy.vomi.core.data.repository.FriendRepository
import com.ssafy.vomi.core.model.call.CallStatus
import com.ssafy.vomi.feature.call.impl.model.CallPhase
import com.ssafy.vomi.feature.call.impl.model.CallUiState
import com.ssafy.vomi.feature.call.impl.model.defaultBackchannels
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@HiltViewModel
internal class CallViewModel @Inject constructor(
    private val calls: CallRepository,
    private val friends: FriendRepository,
) : ViewModel() {
    private val mutableState = MutableStateFlow(CallUiState())
    val uiState = mutableState.asStateFlow()
    private val conversation = CallConversation(mutableState)
    private var initializedCallId: String? = null
    private var actionJob: Job? = null

    fun initialize(callId: String) {
        if (initializedCallId != null) return
        initializedCallId = callId
        mutableState.value = CallUiState(callId = callId, backchannels = defaultBackchannels)
        viewModelScope.launch {
            var namedPeer: String? = null
            var nameJob: Job? = null
            calls.state.collect { signaling ->
                val session = signaling.session?.takeIf { it.id == callId }
                if (session == null) {
                    mutableState.update { it.copy(phase = CallPhase.Ended, isMicrophoneEnabled = false, isSummaryVisible = false) }
                } else {
                    val peerId = session.peerId(signaling.accountId.orEmpty())
                    val phase = when (session.status) {
                        CallStatus.REQUESTED -> if (session.calleeId == signaling.accountId) CallPhase.Incoming else CallPhase.Outgoing
                        CallStatus.ACCEPTED -> CallPhase.Accepted
                        else -> CallPhase.Ended
                    }
                    mutableState.update { state ->
                        state.copy(
                            friendId = peerId,
                            friendName = state.friendName.ifEmpty { peerId },
                            phase = phase,
                            connection = signaling.connection,
                            isCreating = signaling.isCreating,
                            isMicrophoneEnabled = false,
                            isSummaryVisible = state.isSummaryVisible && phase == CallPhase.Active,
                        )
                    }
                    if (namedPeer != peerId) {
                        namedPeer = peerId
                        nameJob?.cancel()
                        nameJob = launch {
                            try {
                                val name = friends.getFriends().first().find { it.id == peerId }?.name ?: peerId
                                mutableState.update { if (it.friendId == peerId) it.copy(friendName = name) else it }
                            } catch (cancelled: CancellationException) { throw cancelled }
                            catch (_: Exception) { /* Keep the peer ID when name lookup fails. */ }
                        }
                    }
                }
            }
        }
    }

    fun retryConnection() = calls.retryConnection()
    fun acceptIncoming() = performAction(accept = true)
    fun endCall() = performAction(accept = false)

    private fun performAction(accept: Boolean) {
        if (actionJob?.isActive == true || calls.state.value.isCreating) return
        val state = mutableState.value
        if (state.phase == CallPhase.Ended || state.phase == CallPhase.Connecting) return
        val callId = initializedCallId ?: return
        actionJob = viewModelScope.launch {
            val action = if (accept) calls.acceptCall(callId) else calls.declineOrEndCall(callId)
            action.asResult().collect { result ->
                mutableState.update {
                    when (result) {
                        Result.Loading -> it.copy(isActionPending = true, hasActionError = false)
                        is Result.Success -> it.copy(isActionPending = false, hasActionError = false)
                        is Result.Error -> it.copy(isActionPending = false, hasActionError = true)
                    }
                }
            }
        }
    }

    fun tick() = conversation.tick()
    fun toggleMicrophone() = conversation.toggleMicrophone()
    fun updateDraft(text: String) = conversation.updateDraft(text)
    fun sendSuggestion(id: Long) = conversation.sendSuggestion(id)
    fun selectSuggestion(id: Long) = conversation.selectSuggestion(id)
    fun sendDraft() = conversation.sendDraft()
    fun selectBackchannel(id: Long) = conversation.selectBackchannel(id)
    fun showSummary() = conversation.showSummary()
    fun dismissSummary() = conversation.dismissSummary()
}
