package com.ssafy.vomi.core.data.repository

import android.os.SystemClock
import com.ssafy.vomi.core.common.network.Dispatcher
import com.ssafy.vomi.core.common.network.VomiDispatcher
import com.ssafy.vomi.core.model.call.CallCaption
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.core.model.speech.SpeechActivity
import com.ssafy.vomi.core.model.speech.SpeechAvailability
import com.ssafy.vomi.core.model.speech.SpeechDownloadEvent
import com.ssafy.vomi.core.model.speech.SpeechError
import com.ssafy.vomi.core.model.speech.SpeechEvent
import com.ssafy.vomi.core.model.speech.SpeechException
import com.ssafy.vomi.core.model.speech.SpeechModelStatus
import com.ssafy.vomi.core.model.speech.SpeechState
import com.ssafy.vomi.core.rtc.RtcClient
import com.ssafy.vomi.core.speech.SpeechClient
import java.util.UUID
import javax.inject.Inject
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

internal class SpeechRepositoryImpl @Inject constructor(
    private val speechClient: SpeechClient,
    private val rtcClient: RtcClient,
    private val callTranscriptRepository: CallTranscriptRepository,
    @param:Dispatcher(VomiDispatcher.IO) private val ioDispatcher: CoroutineDispatcher,
) : SpeechRepository {
    private val mutableState = MutableStateFlow(SpeechState())
    override val speechState = mutableState.asStateFlow()
    private val observationMutex = Mutex()
    private val engineMutex = Mutex()
    private val retryRequests = MutableStateFlow(0L)
    private val stateLock = Any()
    private var activeOwner: Any? = null

    override fun retryRecognition() { retryRequests.update { it + 1 } }

    override fun clearSession() = synchronized(stateLock) {
        activeOwner = null
        mutableState.value = SpeechState()
    }

    override fun observeCall(callId: String, peerId: String, microphoneEnabled: Flow<Boolean>): Flow<Unit> = channelFlow {
        check(observationMutex.tryLock()) { "Call captions already have a foreground owner" }
        val owner = Any()
        synchronized(stateLock) {
            if (mutableState.value.callId != callId) {
                mutableState.value = SpeechState(callId = callId)
            }
            activeOwner = owner
            callTranscriptRepository.beginCall(callId)
        }
        var localJob: Job? = null
        var stopLocal: CompletableDeferred<Unit>? = null
        suspend fun stopRecognition() {
            stopLocal?.complete(Unit)
            localJob?.let { job ->
                if (withTimeoutOrNull(3_000.milliseconds) { job.join(); true } == null) job.cancelAndJoin()
            }
            localJob = null
            stopLocal = null
        }
        // Local recognition failure is contained below. Receiving the peer's captions stays alive.
        val remoteJob = launch {
            rtcClient.observeCaptions(callId, peerId).collect { caption ->
                applyCaption(owner, CallSpeaker.Remote, caption)
                send(Unit)
            }
        }
        try {
            val capability = speechClient.capability()
            update(owner) { it.copy(
                availability = if (capability.available) SpeechAvailability.Available else SpeechAvailability.Unsupported,
                canDownloadModel = capability.canDownloadModel,
            ) }
            combine(microphoneEnabled.distinctUntilChanged(), retryRequests) { enabled, retry -> enabled to retry }
                .collect { (enabled, _) ->
                    stopRecognition()
                    if (enabled) {
                        val stop = CompletableDeferred<Unit>()
                        stopLocal = stop
                        localJob = launch {
                            recognizeLocal(owner, callId, peerId, stop).collect { send(Unit) }
                        }
                    }
                }
        } finally {
            withContext(NonCancellable) {
                try {
                    stopRecognition()
                    remoteJob.cancelAndJoin()
                    synchronized(stateLock) {
                        if (activeOwner === owner) {
                            callTranscriptRepository.discardPartialCaptions(callId)
                            mutableState.value = mutableState.value.copy(activity = SpeechActivity.Idle)
                            activeOwner = null
                        }
                    }
                } finally { observationMutex.unlock() }
            }
        }
    }.onCompletion { error ->
        if (error != null && error !is kotlinx.coroutines.CancellationException) synchronized(stateLock) {
            if (mutableState.value.callId == callId && activeOwner == null) {
                mutableState.value = mutableState.value.copy(error = (error as? SpeechException)?.reason ?: SpeechError.CaptionDeliveryFailed)
            }
        }
    }.flowOn(ioDispatcher)

    private fun recognizeLocal(owner: Any, callId: String, peerId: String, stop: CompletableDeferred<Unit>): Flow<Unit> = flow {
        var utteranceId = UUID.randomUUID().toString()
        var revision = 0L
        var hasPartial = false
        var lastPublishedAt = Long.MIN_VALUE
        suspend fun publish(text: String, final: Boolean) {
            val caption = CallCaption(callId, utteranceId, ++revision, text, final)
            applyCaption(owner, CallSpeaker.Local, caption)
            val now = SystemClock.elapsedRealtime()
            if (final || lastPublishedAt == Long.MIN_VALUE || now - lastPublishedAt >= 200) {
                // A failed data send must not terminate the voice call or peer-caption receiver.
                try {
                    rtcClient.publishCaption(callId, peerId, caption)
                } catch (cancelled: kotlinx.coroutines.CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    throw SpeechException(SpeechError.CaptionDeliveryFailed, error)
                }
                lastPublishedAt = now
            }
        }
        fun nextUtterance() {
            utteranceId = UUID.randomUUID().toString()
            revision = 0
            hasPartial = false
            lastPublishedAt = Long.MIN_VALUE
        }
        try {
            engineMutex.withLock {
                update(owner) { it.copy(activity = SpeechActivity.Starting, error = null) }
                val audio = channelFlow {
                    val capture = launch { rtcClient.observeLocalAudio(callId).collect { send(it) } }
                    try { stop.await() } finally { capture.cancelAndJoin() }
                }
                speechClient.recognize(audio).collect { event ->
                    when (event) {
                        SpeechEvent.Starting -> update(owner) { it.copy(activity = SpeechActivity.Starting) }
                        SpeechEvent.Listening -> update(owner) { it.copy(activity = SpeechActivity.Listening) }
                        SpeechEvent.Finalizing -> update(owner) { it.copy(activity = SpeechActivity.Finalizing) }
                        is SpeechEvent.Partial -> {
                            if (event.text.isNotBlank()) {
                                hasPartial = true
                                publish(event.text.take(1_000), false)
                            } else if (hasPartial) {
                                publish("", true)
                                nextUtterance()
                            }
                        }
                        is SpeechEvent.Final -> {
                            for (part in event.text.trim().chunked(1_000)) {
                                publish(part, true)
                                nextUtterance()
                            }
                            update(owner) { it.copy(modelStatus = SpeechModelStatus.Ready, activity = SpeechActivity.Listening) }
                        }
                    }
                    emit(Unit)
                }
            }
        } finally {
            // Drop an unfinished hypothesis on both screens; never claim it was a final recognition result.
            if (hasPartial) {
                val cancellation = CallCaption(callId, utteranceId, ++revision, "", true)
                applyCaption(owner, CallSpeaker.Local, cancellation)
                withContext(NonCancellable) {
                    withTimeoutOrNull(500.milliseconds) {
                        flow { rtcClient.publishCaption(callId, peerId, cancellation); emit(Unit) }.catch { }.collect { }
                    }
                }
            }
            update(owner) { if (it.activity != SpeechActivity.Downloading) it.copy(activity = SpeechActivity.Idle) else it }
        }
    }.catch { error ->
        update(owner) { it.copy(error = (error as? SpeechException)?.reason ?: SpeechError.RecognitionFailed) }
        emit(Unit)
    }

    override fun downloadKoreanModel(): Flow<Unit> = flow {
        val owner = synchronized(stateLock) { activeOwner } ?: return@flow
        if (!engineMutex.tryLock()) throw SpeechException(SpeechError.AudioBusy)
        try {
            update(owner) { it.copy(activity = SpeechActivity.Downloading, downloadProgress = null, error = null) }
            speechClient.downloadKoreanModel().collect { event ->
                update(owner) { current ->
                    when (event) {
                        is SpeechDownloadEvent.Progress -> current.copy(downloadProgress = event.percent, modelStatus = SpeechModelStatus.Requested)
                        SpeechDownloadEvent.Ready -> current.copy(modelStatus = SpeechModelStatus.Ready)
                        SpeechDownloadEvent.Scheduled -> current.copy(modelStatus = SpeechModelStatus.Scheduled)
                        SpeechDownloadEvent.Requested -> current.copy(modelStatus = SpeechModelStatus.Requested)
                    }
                }
                emit(Unit)
            }
        } catch (error: Exception) {
            // This shared status belongs to the owner that requested the download, even if the call changes.
            if (error !is kotlinx.coroutines.CancellationException) {
                update(owner) { it.copy(error = (error as? SpeechException)?.reason ?: SpeechError.DownloadFailed) }
            }
            throw error
        } finally {
            update(owner) { it.copy(activity = SpeechActivity.Idle, downloadProgress = null) }
            engineMutex.unlock()
        }
    }.flowOn(ioDispatcher)

    private fun update(owner: Any, transform: (SpeechState) -> SpeechState) = synchronized(stateLock) {
        if (activeOwner === owner) mutableState.value = transform(mutableState.value)
    }

    private fun applyCaption(owner: Any, speaker: CallSpeaker, caption: CallCaption) = synchronized(stateLock) {
        if (activeOwner === owner && caption.callId == mutableState.value.callId) {
            callTranscriptRepository.applyCaption(speaker, caption)
        }
    }
}
