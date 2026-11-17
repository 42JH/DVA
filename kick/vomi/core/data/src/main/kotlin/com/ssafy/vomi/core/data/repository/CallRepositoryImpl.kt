package com.ssafy.vomi.core.data.repository

import android.os.SystemClock
import com.ssafy.vomi.core.data.call.serverSpeechStream
import com.ssafy.vomi.core.data.call.speechTextParts
import com.ssafy.vomi.core.model.call.CallMediaEvent
import com.ssafy.vomi.core.model.call.CallMessageDelivery
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.core.model.call.CallTextError
import com.ssafy.vomi.core.model.call.CallTextException
import com.ssafy.vomi.core.model.call.CallTextSendProgress
import com.ssafy.vomi.core.model.call.CallTextSendStage
import com.ssafy.vomi.core.network.service.voice.VoiceClient
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.transform
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import com.ssafy.vomi.core.common.network.Dispatcher
import com.ssafy.vomi.core.common.network.VomiDispatcher
import com.ssafy.vomi.core.data.call.CallSessionStore
import com.ssafy.vomi.core.data.mapper.toModel
import com.ssafy.vomi.core.model.call.CallMediaConnection
import com.ssafy.vomi.core.model.call.CallMediaState
import com.ssafy.vomi.core.model.call.CallStatus
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallSnapshot
import com.ssafy.vomi.core.network.model.call.CallAction
import com.ssafy.vomi.core.network.model.call.CreateCallRequest
import com.ssafy.vomi.core.network.service.call.CallClient
import com.ssafy.vomi.core.network.service.call.CallEvents
import com.ssafy.vomi.core.rtc.RtcClient
import java.io.IOException
import javax.inject.Inject
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.flow.update
import retrofit2.HttpException

internal class CallRepositoryImpl @Inject constructor(
    private val callClient: CallClient,
    private val callEvents: CallEvents,
    private val rtcClient: RtcClient,
    private val voiceClient: VoiceClient,
    private val callTranscriptRepository: CallTranscriptRepository,
    @param:Dispatcher(VomiDispatcher.IO) private val ioDispatcher: CoroutineDispatcher,
) : CallRepository {
    private val callSessionStore = CallSessionStore(SystemClock::elapsedRealtime)
    override val callState = callSessionStore.state
    private val outgoingAudioMutex = Mutex()
    private val retryRequests = MutableStateFlow(0L)
    override val reconnectRequests: Flow<Unit> = retryRequests.map { Unit }

    override fun beginSession(userId: String) {
        require(userId.isNotBlank())
        callSessionStore.beginSession(userId)
    }

    override fun clearSession() {
        callSessionStore.clear()
        callTranscriptRepository.clearSession()
    }

    override fun retryConnection() {
        retryRequests.update { it + 1 }
    }

    override fun createCall(calleeId: String, requestId: String): Flow<CallSession> = flow {
        val userId = requireUserId()
        check(callSessionStore.tryStartCreating(userId)) { "A call cannot be created in the current state" }
        try {
            emitAll(
                flow {
                    val response = callClient.createCall(CreateCallRequest(calleeId, requestId))
                    emit(loadCall(response.id, userId))
                }.catch { error ->
                    refreshAfterFailure(userId)
                    throw error
                },
            )
        } finally {
            callSessionStore.finishCreating(userId)
        }
    }.flowOn(ioDispatcher)

    override fun getActiveCall(): Flow<CallSnapshot> = flow {
        emit(loadActiveCall(requireUserId()))
    }.flowOn(ioDispatcher)

    override fun getCall(callId: String): Flow<CallSession> = flow {
        emit(loadCall(callId, requireUserId()))
    }.flowOn(ioDispatcher)

    override fun observeCalls(): Flow<CallSnapshot> = flow {
        val userId = requireUserId()
        var failures = 0
        emitAll(
            flow {
                callSessionStore.setConnection(
                    userId,
                    if (failures == 0) CallConnection.Connecting else CallConnection.Reconnecting,
                )
                emit(loadActiveCall(userId))
                callEvents.events().collect { response ->
                    val snapshot = CallSnapshot(response.accountId, response.call?.toModel())
                    callSessionStore.applySnapshot(snapshot, userId)
                    callSessionStore.setConnection(userId, CallConnection.Connected)
                    failures = 0
                    emit(snapshot)
                }
                throw IOException("Call events disconnected")
            }.retryWhen { error, _ ->
                if (error is HttpException && (error.code() == 401 || error.code() == 403)) {
                    false
                } else {
                    callSessionStore.setConnection(userId, CallConnection.Reconnecting)
                    delay((1_000L shl failures.coerceAtMost(5)).coerceAtMost(30_000L).milliseconds)
                    failures = (failures + 1).coerceAtMost(5)
                    true
                }
            }.onCompletion { error ->
                callSessionStore.setConnection(
                    userId,
                    if (error is HttpException && error.code() == 403) CallConnection.Failed else CallConnection.Stopped,
                )
            },
        )
    }.flowOn(ioDispatcher)

    override fun observeMedia(): Flow<CallMediaState> = channelFlow {
        val userId = requireUserId()
        val acceptedCall = callState.map { state ->
            state.session?.takeIf { state.accountId == userId && it.status == CallStatus.ACCEPTED }?.id
        }.distinctUntilChanged()
        combine(acceptedCall, retryRequests) { callId, _ -> callId }.collectLatest { callId ->
            if (callId == null) return@collectLatest
            callTranscriptRepository.beginCall(callId)
            val connecting = CallMediaState(callId, CallMediaConnection.Connecting)
            callSessionStore.applyMedia(connecting, userId)
            send(connecting)
            try {
                flow {
                    val response = callClient.joinCall(callId)
                    currentCoroutineContext().ensureActive()
                    val current = callState.value
                    if (current.accountId == userId && current.session?.id == callId &&
                        current.session?.status == CallStatus.ACCEPTED) {
                        emitAll(rtcClient.connect(callId, response.url, response.token, checkNotNull(current.session).peerId(userId)).transform { event ->
                            when (event) {
                                is CallMediaEvent.Media -> emit(event.state)
                                is CallMediaEvent.TextReceived -> callTranscriptRepository.putText(
                                    event.callId, event.messageId, CallSpeaker.Remote, event.text, CallMessageDelivery.Complete,
                                )
                                is CallMediaEvent.PlaybackStatus -> callTranscriptRepository.setPlaybackError(event.callId, event.hasError)
                            }
                        })
                    }
                }.catch { error ->
                    if (error is HttpException && error.code() == 401) throw error
                    emit(CallMediaState(callId, CallMediaConnection.Failed))
                }.collect { media ->
                    callSessionStore.applyMedia(media, userId)
                    send(media)
                }
            } finally {
                callSessionStore.stopMedia(userId, callId)
            }
        }
    }.flowOn(ioDispatcher)

    override fun sendTextAudio(callId: String, messageId: String, text: String): Flow<CallTextSendProgress> = channelFlow {
        val userId = requireUserId()
        val value = text.trim()
        if (value.isEmpty() || value.length > 10_000 || messageId.length !in 1..100) throw CallTextException(CallTextError.InvalidText)
        val parts = speechTextParts(value)
        if (!outgoingAudioMutex.tryLock()) throw CallTextException(CallTextError.Busy)
        var textDelivered = false
        var completed = false
        var recorded = false
        val guard = launch {
            callState.first { !canSendText(it, userId, callId) }
            this@channelFlow.cancel("The call's audio connection changed")
        }
        try {
            if (!canSendText(callState.value, userId, callId)) throw CallTextException(CallTextError.CallUnavailable)
            val previous = callTranscriptRepository.transcriptState.value.messages.find {
                it.textMessageId == messageId && it.speaker == CallSpeaker.Local
            }
            textDelivered = previous?.delivery in setOf(CallMessageDelivery.TextSent, CallMessageDelivery.AudioFailed, CallMessageDelivery.Complete)
            callTranscriptRepository.putText(callId, messageId, CallSpeaker.Local, value, CallMessageDelivery.Sending)
            recorded = true
            if (!textDelivered) {
                callTranscriptRepository.setTextDelivery(callId, messageId, CallMessageDelivery.Sending)
                send(CallTextSendProgress(messageId, CallTextSendStage.SendingText))
                rtcClient.sendText(callId, messageId, value)
                textDelivered = true
            }
            callTranscriptRepository.setTextDelivery(callId, messageId, CallMessageDelivery.TextSent)
            send(CallTextSendProgress(messageId, CallTextSendStage.TextSent))
            send(CallTextSendProgress(messageId, CallTextSendStage.SendingAudio))
            rtcClient.sendSpeech(callId, messageId, serverSpeechStream(voiceClient, parts, ioDispatcher))
            callTranscriptRepository.setTextDelivery(callId, messageId, CallMessageDelivery.Complete)
            completed = true
            send(CallTextSendProgress(messageId, CallTextSendStage.Complete))
        } finally {
            withContext(NonCancellable) {
                guard.cancelAndJoin()
                if (recorded && !completed) callTranscriptRepository.setTextDelivery(callId, messageId,
                    if (textDelivered) CallMessageDelivery.AudioFailed else CallMessageDelivery.Failed)
                outgoingAudioMutex.unlock()
            }
        }
    }.catch { error ->
        // Transport-specific failures become a model error at the data boundary; UI still collects asResult().
        val reason = when (error) {
            is HttpException -> when (error.code()) {
                400 -> CallTextError.InvalidText
                401, 403 -> CallTextError.Authentication
                409 -> CallTextError.VoiceNotReady
                else -> CallTextError.Server
            }
            is IOException -> CallTextError.Network
            else -> null
        }
        if (reason == null) throw error else throw CallTextException(reason, error)
    }.flowOn(ioDispatcher)

    private fun canSendText(state: com.ssafy.vomi.core.model.call.CallSignalingState, userId: String, callId: String) =
        state.accountId == userId && state.session?.id == callId && state.session?.status == CallStatus.ACCEPTED &&
            state.media.callId == callId && state.media.connection == CallMediaConnection.Connected &&
            state.media.isPeerConnected && !state.media.isMicrophoneEnabled && !state.isCreating

    override fun setMicrophoneEnabled(callId: String, enabled: Boolean): Flow<Unit> = flow {
        outgoingAudioMutex.withLock {
            val current = callState.value
            check(current.session?.id == callId && current.session?.status == CallStatus.ACCEPTED &&
                current.media.callId == callId && current.media.connection == CallMediaConnection.Connected) {
                "The current voice call is not connected"
            }
            rtcClient.setMicrophoneEnabled(callId, enabled)
            val confirmed = withTimeoutOrNull(5_000.milliseconds) {
                callState.first { state ->
                    state.accountId != current.accountId || state.session?.id != callId ||
                        state.media.connection != CallMediaConnection.Connected || state.media.isMicrophoneEnabled == enabled
                }
            }
            check(confirmed != null && confirmed.accountId == current.accountId && confirmed.session?.id == callId &&
                confirmed.media.connection == CallMediaConnection.Connected && confirmed.media.isMicrophoneEnabled == enabled) {
                "The shared microphone state was not confirmed"
            }
            emit(Unit)
        }
    }.flowOn(ioDispatcher)

    override fun acceptCall(callId: String) = changeCall(callId, CallAction.ACCEPT)
    override fun rejectCall(callId: String) = changeCall(callId, CallAction.REJECT)
    override fun cancelCall(callId: String) = changeCall(callId, CallAction.CANCEL)
    override fun endCall(callId: String) = changeCall(callId, CallAction.END)

    private fun changeCall(callId: String, action: CallAction): Flow<CallSession> = flow {
        val userId = requireUserId()
        emitAll(
            flow {
                if (action == CallAction.END) rtcClient.disconnect(callId)
                callClient.updateCall(callId, action)
                emit(loadCall(callId, userId))
            }.catch { error ->
                refreshAfterFailure(userId)
                throw error
            },
        )
    }.flowOn(ioDispatcher)

    private suspend fun loadActiveCall(userId: String): CallSnapshot {
        val response = callClient.getActiveCall()
        val snapshot = CallSnapshot(response.accountId, response.call?.toModel())
        callSessionStore.applySnapshot(snapshot, userId)
        return snapshot
    }

    private suspend fun loadCall(callId: String, userId: String): CallSession {
        val session = callClient.getCall(callId).toModel()
        callSessionStore.applyCall(session, userId)
        return session
    }

    private suspend fun refreshAfterFailure(userId: String) {
        if (callState.value.accountId != userId) return
        flow { emit(loadActiveCall(userId)) }
            .catch { /* Preserve the original command error if recovery is unavailable. */ }
            .collect { }
    }

    private fun requireUserId(): String = checkNotNull(callState.value.accountId) {
        "A call session must be initialized before collecting call operations"
    }
}
