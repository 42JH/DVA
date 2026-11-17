package com.ssafy.vomi.feature.call.impl

import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ssafy.vomi.core.common.result.Result
import com.ssafy.vomi.core.common.result.asResult
import com.ssafy.vomi.core.data.repository.CallRepository
import com.ssafy.vomi.core.data.repository.FriendRepository
import com.ssafy.vomi.core.model.call.CallMediaConnection
import com.ssafy.vomi.core.model.call.CallStatus
import com.ssafy.vomi.feature.call.impl.model.CallPhase
import com.ssafy.vomi.feature.call.impl.model.CallUiState
import com.ssafy.vomi.feature.call.impl.model.defaultBackchannels
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@HiltViewModel
internal class CallViewModel @Inject constructor(
    private val callRepository: CallRepository,
    private val friendRepository: FriendRepository,
) : ViewModel() {
    private val mutableState = MutableStateFlow(CallUiState())
    val uiState = mutableState.asStateFlow()
    private val conversation = CallConversation(mutableState)
    private var initializedCallId: String? = null
    private var actionJob: Job? = null
    private var microphoneJob: Job? = null

    fun initialize(callId: String) {
        if (initializedCallId != null) return
        initializedCallId = callId
        mutableState.value = CallUiState(callId = callId, backchannels = defaultBackchannels)
        viewModelScope.launch {
            var namedPeer: String? = null
            var nameJob: Job? = null
            callRepository.callState.collect { signaling ->
                val session = signaling.session?.takeIf { it.id == callId }
                if (session == null) {
                    mutableState.update { it.copy(phase = CallPhase.Ended, isMicrophoneEnabled = false, mediaConnection = CallMediaConnection.Disconnected, isSummaryVisible = false) }
                } else {
                    val peerId = session.peerId(signaling.accountId.orEmpty())
                    val phase = when (session.status) {
                        CallStatus.REQUESTED -> if (session.calleeId == signaling.accountId) CallPhase.Incoming else CallPhase.Outgoing
                        CallStatus.ACCEPTED -> if (
                            signaling.media.callId == callId &&
                            signaling.media.connection == CallMediaConnection.Connected && signaling.media.isPeerConnected
                        ) CallPhase.Active else CallPhase.Accepted
                        else -> CallPhase.Ended
                    }
                    mutableState.update { state ->
                        state.copy(
                            friendId = peerId,
                            friendName = state.friendName.ifEmpty { peerId },
                            phase = phase,
                            connection = signaling.connection,
                            isCreating = signaling.isCreating,
                            isMicrophoneEnabled = signaling.media.isMicrophoneEnabled,
                            mediaConnection = signaling.media.connection,
                            isSummaryVisible = state.isSummaryVisible && phase == CallPhase.Active,
                        )
                    }
                    if (namedPeer != peerId) {
                        namedPeer = peerId
                        nameJob?.cancel()
                        nameJob = launch {
                            friendRepository.getFriends().asResult().collect { result ->
                                if (result is Result.Success) {
                                    val name = result.data.find { it.id == peerId }?.name ?: peerId
                                    mutableState.update { if (it.friendId == peerId) it.copy(friendName = name) else it }
                                }
                            }
                        }
                    }
                }
            }
        }
        viewModelScope.launch {
            while (isActive) {
                val signaling = callRepository.callState.value
                val start = signaling.startedAtElapsedRealtime
                if (signaling.session?.id == callId && start != null) {
                    val elapsed = ((SystemClock.elapsedRealtime() - start) / 1_000).coerceAtLeast(0)
                    mutableState.update { it.copy(elapsedSeconds = elapsed) }
                }
                delay(1_000.milliseconds)
            }
        }
    }

    fun retryConnection() = callRepository.retryConnection()
    fun acceptIncoming() = performAction(accept = true)
    fun endCall() = performAction(accept = false)

    private fun performAction(accept: Boolean) {
        if (actionJob?.isActive == true || callRepository.callState.value.isCreating) return
        val callId = initializedCallId ?: return
        val signaling = callRepository.callState.value
        val userId = signaling.accountId ?: return
        val session = signaling.session?.takeIf { it.id == callId && !it.isTerminal } ?: return
        if (accept && (session.calleeId != userId || session.status != CallStatus.REQUESTED)) return
        if (!accept) microphoneJob?.cancel()
        actionJob = viewModelScope.launch {
            val action = when {
                accept -> callRepository.acceptCall(callId)
                session.status == CallStatus.ACCEPTED -> callRepository.endCall(callId)
                session.callerId == userId -> callRepository.cancelCall(callId)
                else -> callRepository.rejectCall(callId)
            }
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

    fun toggleMicrophone() {
        if (microphoneJob?.isActive == true || !mutableState.value.canToggleMicrophone) return
        val callId = initializedCallId ?: return
        val enabled = !mutableState.value.isMicrophoneEnabled
        microphoneJob = viewModelScope.launch {
            try {
                callRepository.setMicrophoneEnabled(callId, enabled).asResult().collect { result ->
                    mutableState.update { state ->
                        when (result) {
                            Result.Loading -> state.copy(isMicrophonePending = true, hasMicrophoneError = false, isMicrophonePermissionDenied = false)
                            is Result.Success -> state.copy(
                                isMicrophonePending = false,
                                hasMicrophoneError = false,
                                isMicrophoneEnabled = callRepository.callState.value.media.isMicrophoneEnabled,
                            )
                            is Result.Error -> state.copy(isMicrophonePending = false, hasMicrophoneError = true)
                        }
                    }
                }
            } finally {
                mutableState.update { it.copy(isMicrophonePending = false) }
            }
        }
    }

    fun onMicrophonePermissionResult(granted: Boolean) {
        mutableState.update { it.copy(isMicrophonePermissionDenied = !granted) }
        if (granted && !mutableState.value.isMicrophoneEnabled) toggleMicrophone()
    }
    fun updateDraft(text: String) = conversation.updateDraft(text)
    fun sendSuggestion(id: Long) = conversation.sendSuggestion(id)
    fun selectSuggestion(id: Long) = conversation.selectSuggestion(id)
    fun sendDraft() = conversation.sendDraft()
    fun selectBackchannel(id: Long) = conversation.selectBackchannel(id)
    fun showSummary() = conversation.showSummary()
    fun dismissSummary() = conversation.dismissSummary()
}
