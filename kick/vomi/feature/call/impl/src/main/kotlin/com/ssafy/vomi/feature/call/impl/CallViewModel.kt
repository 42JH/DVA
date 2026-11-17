package com.ssafy.vomi.feature.call.impl

import android.os.SystemClock
import com.ssafy.vomi.core.data.repository.CallTranscriptRepository
import com.ssafy.vomi.core.model.call.CallMessageDelivery
import com.ssafy.vomi.core.model.call.CallTextError
import com.ssafy.vomi.core.model.call.CallTextException
import com.ssafy.vomi.core.model.call.CallTextRequest
import com.ssafy.vomi.core.model.call.CallTextSendStage
import java.util.UUID
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ssafy.vomi.core.common.result.Result
import com.ssafy.vomi.core.common.result.asResult
import com.ssafy.vomi.core.data.repository.CallRepository
import com.ssafy.vomi.core.data.repository.FriendRepository
import com.ssafy.vomi.core.data.repository.ReplySuggestionRepository
import com.ssafy.vomi.core.model.ai.ReplyModelAvailability
import com.ssafy.vomi.core.model.ai.ReplyModelState
import com.ssafy.vomi.core.model.ai.ReplyRecommendationError
import com.ssafy.vomi.core.model.ai.ReplyRecommendationException
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.CallSpeaker
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import com.ssafy.vomi.core.data.repository.SpeechRepository
import com.ssafy.vomi.core.model.speech.SpeechError
import com.ssafy.vomi.core.model.speech.SpeechException
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
    private val speechRepository: SpeechRepository,
    private val replySuggestionRepository: ReplySuggestionRepository,
    private val callTranscriptRepository: CallTranscriptRepository,
) : ViewModel() {
    private val mutableState = MutableStateFlow(CallUiState())
    val uiState = mutableState.asStateFlow()
    private val conversation = CallConversation(mutableState)
    private var initializedCallId: String? = null
    private var textSendJob: Job? = null
    private var actionJob: Job? = null
    private var microphoneJob: Job? = null
    private var modelDownloadJob: Job? = null
    private var replyModelJob: Job? = null
    private val replySessionId = UUID.randomUUID().toString()
    private val replySessionReady = MutableStateFlow(false)
    private val recommendationForeground = MutableStateFlow(false)
    private val replyRetryRequests = MutableStateFlow(0L)
    private var replyRevision = 0L

    fun initialize(callId: String) {
        if (initializedCallId != null) return
        initializedCallId = callId
        mutableState.value = CallUiState(callId = callId, backchannels = defaultBackchannels)
        observeReplyModelSession()
        observeReplyRecommendations()
        viewModelScope.launch {
            callTranscriptRepository.transcriptState.collect { transcript ->
                if (transcript.callId == callId) mutableState.update {
                    it.copy(messages = transcript.messages, hasPlaybackError = transcript.hasPlaybackError)
                }
            }
        }
        viewModelScope.launch {
            speechRepository.speechState.collect { speech ->
                if (speech.callId == callId) mutableState.update { it.copy(speech = speech) }
            }
        }
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

    fun setRecommendationForeground(visible: Boolean) {
        recommendationForeground.value = visible
    }

    private fun observeReplyModelSession() {
        viewModelScope.launch {
            uiState.map { it.phase != CallPhase.Ended }.distinctUntilChanged().collectLatest { ongoing ->
                if (!ongoing) return@collectLatest
                try {
                    replySuggestionRepository.openModelSession(replySessionId).asResult().collect { result ->
                        when (result) {
                            Result.Loading -> Unit
                            is Result.Success -> replySessionReady.value = true
                            is Result.Error -> mutableState.update { it.copy(
                                replyModel = ReplyModelState(), replyModelError = ReplyRecommendationError.Failed,
                            ) }
                        }
                    }
                } finally {
                    replySessionReady.value = false
                }
            }
        }
    }

    private fun observeReplyRecommendations() {
        viewModelScope.launch {
            combine(recommendationForeground, replySessionReady,
                uiState.map { it.phase != CallPhase.Ended }.distinctUntilChanged()) {
                visible, ready, ongoing -> visible && ready && ongoing
            }.distinctUntilChanged().collectLatest { eligible ->
                if (eligible) checkReplyModel()
                else {
                    replyModelJob?.cancelAndJoin()
                    mutableState.update { state ->
                        state.copy(
                            suggestions = emptyList(), isGeneratingReplies = false, suggestionSourceMessageId = null,
                            replyGenerationError = null, isReplyModelOperationPending = false,
                            replyModel = if (state.replyModel.availability == ReplyModelAvailability.Checking ||
                                state.replyModel.availability == ReplyModelAvailability.Downloading) ReplyModelState() else state.replyModel,
                        )
                    }
                }
            }
        }
        viewModelScope.launch {
            val requests = uiState.map { state ->
                val dialogue = state.replyDialogue()
                val last = dialogue.lastOrNull()
                if (state.phase == CallPhase.Active && !state.isActionPending && !state.isSendingText && !state.isReplyModelOperationPending &&
                    state.messages.none { !it.isFinal } && state.replyModel.availability == ReplyModelAvailability.Available &&
                    last?.speaker == CallSpeaker.Remote && last.isFinal && last.text.isNotBlank()) {
                    dialogue.takeLast(13)
                } else null
            }.distinctUntilChanged()
            combine(recommendationForeground, replySessionReady, requests, replyRetryRequests) { visible, ready, messages, retry ->
                (if (visible && ready) messages else null) to retry
            }.distinctUntilChanged().collectLatest { (messages, _) ->
                val revision = ++replyRevision
                if (messages == null) {
                    mutableState.update { it.copy(suggestions = emptyList(), isGeneratingReplies = false,
                        replyGenerationError = null, suggestionSourceMessageId = null) }
                    return@collectLatest
                }
                val sourceId = messages.last().id
                try {
                    replySuggestionRepository.recommendReplies(replySessionId, messages).asResult().collect { result ->
                        if (revision != replyRevision || !isCurrentReplyRequest(messages)) return@collect
                        mutableState.update { state ->
                            when (result) {
                                Result.Loading -> state.copy(suggestions = emptyList(), isGeneratingReplies = true,
                                    replyGenerationError = null, suggestionSourceMessageId = sourceId)
                                is Result.Success -> state.copy(suggestions = result.data, isGeneratingReplies = true)
                                is Result.Error -> {
                                    val error = result.exception as? ReplyRecommendationException
                                    state.copy(
                                        isGeneratingReplies = false,
                                        replyGenerationError = error?.reason ?: ReplyRecommendationError.Failed,
                                        suggestions = state.suggestions.filter { it.isComplete },
                                        replyModel = error?.modelAvailability?.let { ReplyModelState(it) } ?: state.replyModel,
                                    )
                                }
                            }
                        }
                    }
                } finally {
                    if (revision == replyRevision) mutableState.update { it.copy(isGeneratingReplies = false) }
                }
            }
        }
    }

    private fun isCurrentReplyRequest(messages: List<CallMessage>): Boolean {
        val state = mutableState.value
        val dialogue = state.replyDialogue()
        val last = dialogue.lastOrNull()
        return recommendationForeground.value && replySessionReady.value && state.phase == CallPhase.Active &&
            !state.isActionPending && !state.isSendingText && !state.isReplyModelOperationPending &&
            state.messages.none { !it.isFinal } && state.replyModel.availability == ReplyModelAvailability.Available && last?.isFinal == true &&
            last.speaker == CallSpeaker.Remote && dialogue.takeLast(13) == messages
    }

    private fun CallUiState.replyDialogue() = messages.filter {
        it.isFinal && it.delivery != CallMessageDelivery.Sending && it.delivery != CallMessageDelivery.Failed
    }

    fun checkReplyModel() = performReplyModelOperation(download = false)
    fun prepareReplyModel() = performReplyModelOperation(download = true)

    private fun performReplyModelOperation(download: Boolean) {
        if (!recommendationForeground.value || !replySessionReady.value ||
            mutableState.value.phase == CallPhase.Ended || replyModelJob?.isActive == true) return
        // Readiness changes invalidate any pending generation before another SDK operation is started.
        mutableState.update { it.copy(
            replyModel = ReplyModelState(if (download) ReplyModelAvailability.Downloading else ReplyModelAvailability.Checking),
            replyModelError = null,
            isReplyModelOperationPending = true,
        ) }
        replyModelJob = viewModelScope.launch {
            val operation = if (download) replySuggestionRepository.prepareModel(replySessionId) else replySuggestionRepository.checkModel(replySessionId)
            try {
                operation.asResult().collect { result ->
                    mutableState.update { state ->
                        when (result) {
                            Result.Loading -> state
                            is Result.Success -> state.copy(replyModel = result.data, replyModelError = null)
                            is Result.Error -> {
                                val error = result.exception as? ReplyRecommendationException
                                state.copy(
                                    replyModel = ReplyModelState(error?.modelAvailability ?: ReplyModelAvailability.Unknown),
                                    replyModelError = error?.reason ?: ReplyRecommendationError.Failed,
                                )
                            }
                        }
                    }
                }
            } finally {
                mutableState.update { it.copy(isReplyModelOperationPending = false) }
            }
        }
    }

    fun retryReplyRecommendations() {
        if (recommendationForeground.value && mutableState.value.phase == CallPhase.Active && !mutableState.value.isGeneratingReplies) {
            if (mutableState.value.replyModel.availability == ReplyModelAvailability.Available) replyRetryRequests.update { it + 1 }
            else checkReplyModel()
        }
    }

    fun retryCaptions() = speechRepository.retryRecognition()

    fun prepareSpeechModel() {
        if (modelDownloadJob?.isActive == true || mutableState.value.isMicrophoneEnabled) return
        modelDownloadJob = viewModelScope.launch {
            speechRepository.downloadKoreanModel().asResult().collect { result ->
                if (result is Result.Error) mutableState.update {
                    it.copy(speech = it.speech.copy(error = (result.exception as? SpeechException)?.reason ?: SpeechError.DownloadFailed))
                }
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
        if (!accept) { microphoneJob?.cancel(); textSendJob?.cancel() }
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
    fun sendSuggestion(id: Long) {
        conversation.suggestionToSend(id)?.let { sendText(it) }
    }
    fun selectSuggestion(id: Long) = conversation.selectSuggestion(id)
    fun sendDraft() { conversation.draftToSend()?.let { sendText(it, fromDraft = true) } }
    fun selectBackchannel(id: Long) {
        conversation.backchannelToSend(id)?.let { sendText(it) }
    }

    fun retryTextAudio() {
        mutableState.value.failedTextRequest?.let { performTextSend(it, fromDraft = false) }
    }

    private fun sendText(text: String, fromDraft: Boolean = false) {
        if (text.isBlank()) return
        performTextSend(CallTextRequest(UUID.randomUUID().toString(), text.trim()), fromDraft)
    }

    private fun performTextSend(request: CallTextRequest, fromDraft: Boolean) {
        if (textSendJob?.isActive == true || !mutableState.value.canType) return
        val callId = initializedCallId ?: return
        mutableState.update { it.copy(isSendingText = true, textSendError = null, failedTextRequest = null) }
        textSendJob = viewModelScope.launch {
            var finished = false
            var textDelivered = false
            try {
                callRepository.sendTextAudio(callId, request.messageId, request.text).asResult().collect { result ->
                    when (result) {
                        Result.Loading -> Unit
                        is Result.Success -> {
                            if (result.data.stage == CallTextSendStage.TextSent) textDelivered = true
                            if (result.data.stage == CallTextSendStage.TextSent && fromDraft) mutableState.update {
                                if (it.draft.trim() == request.text) it.copy(draft = "") else it
                            }
                            if (result.data.stage == CallTextSendStage.Complete) finished = true
                        }
                        is Result.Error -> {
                            finished = true
                            val reason = (result.exception as? CallTextException)?.reason
                                ?: if (textDelivered) CallTextError.AudioDelivery else CallTextError.TextDelivery
                            mutableState.update { it.copy(textSendError = reason,
                                failedTextRequest = if (reason == CallTextError.InvalidText) null else request) }
                        }
                    }
                }
            } finally {
                mutableState.update { state -> state.copy(
                    isSendingText = false,
                    textSendError = if (!finished) CallTextError.CallUnavailable else state.textSendError,
                    failedTextRequest = if (!finished) request else state.failedTextRequest,
                ) }
            }
        }
    }
    fun showSummary() = conversation.showSummary()
    fun dismissSummary() = conversation.dismissSummary()
}
