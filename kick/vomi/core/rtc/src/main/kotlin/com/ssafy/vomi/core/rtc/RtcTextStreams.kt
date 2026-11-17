package com.ssafy.vomi.core.rtc

import com.ssafy.vomi.core.model.call.CallMediaEvent
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.core.model.call.CallSpeechSegment
import com.ssafy.vomi.core.model.call.CallTextError
import com.ssafy.vomi.core.model.call.CallTextException
import com.ssafy.vomi.core.model.call.CallTextPlayback
import com.ssafy.vomi.core.model.call.CallTextPlaybackStatus
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.datastream.StreamBytesOptions
import io.livekit.android.room.datastream.StreamTextOptions
import io.livekit.android.room.datastream.incoming.ByteStreamReceiver
import io.livekit.android.room.datastream.outgoing.ByteStreamSender
import io.livekit.android.room.participant.Participant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.CoroutineContext
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

/** One instance per Room; every stream, player and acknowledgement ends with that Room. */
internal class RtcTextStreams(
    private val callId: String,
    private val peerId: String,
    private val room: Room,
    parentContext: CoroutineContext,
    private val emit: suspend (CallMediaEvent) -> Unit,
) {
    private data class IncomingAudio(val reader: ByteStreamReceiver, val messageId: String, val info: SpeechPlaybackProtocol.SegmentInfo?)
    private val closed = AtomicBoolean(false)
    private val receiverJob = SupervisorJob(parentContext[Job])
    private val receiverScope = CoroutineScope(parentContext + receiverJob + Dispatchers.IO)
    private val sendJobs = mutableSetOf<Job>()
    private val incomingAudio = Channel<IncomingAudio>(4)
    private val playbackFeedback = MutableStateFlow<Map<String, CallTextPlayback>>(emptyMap())
    private val sequences = ConcurrentHashMap<String, AtomicLong>()
    private val messageAttempts = linkedMapOf<String, String>()
    private val cancelledAttempts = linkedSetOf<String>()
    @Volatile private var playing: Pair<String, Job>? = null

    init {
        receiverScope.launch {
            for (audio in incomingAudio) {
                val job = receiverScope.launch(start = CoroutineStart.LAZY) { playIncoming(audio) }
                playing = audio.info?.let { it.playbackId to job }
                job.start()
                job.join()
                if (playing?.second === job) playing = null
            }
        }
        receiverScope.launch(Dispatchers.Main.immediate) {
            room.events.collect { event ->
                if (event is RoomEvent.DataReceived && event.topic == SpeechPlaybackProtocol.TOPIC && event.participant?.identity?.value == peerId) {
                    SpeechPlaybackProtocol.decode(event.data, callId)?.let { packet ->
                        receiverScope.launch {
                            if (packet.progress != null) {
                                playbackFeedback.update { previous ->
                                    val old = previous[packet.playbackId]
                                    if (old != null && old.sequence >= packet.progress.sequence) previous
                                    else (previous + (packet.playbackId to packet.progress)).entries.toList().takeLast(200).associate { it.toPair() }
                                }
                                emit(CallMediaEvent.TextPlayback(callId, packet.messageId, CallSpeaker.Local, packet.progress))
                            } else {
                                val current = synchronized(messageAttempts) { messageAttempts[packet.messageId] }
                                if (current == null || current == packet.playbackId) {
                                    synchronized(cancelledAttempts) {
                                        cancelledAttempts.add(packet.playbackId)
                                        while (cancelledAttempts.size > 200) cancelledAttempts.remove(cancelledAttempts.first())
                                    }
                                    val active = playing?.takeIf { it.first == packet.playbackId }
                                    if (active?.second?.isActive == true) active.second.cancel()
                                    else publishProgress(packet.messageId, CallTextPlayback(packet.playbackId,
                                        nextSequence(packet.playbackId), status = CallTextPlaybackStatus.Interrupted))
                                }
                            }
                        }
                    }
                }
            }
        }
        room.registerTextStreamHandler(TEXT_TOPIC) { reader, identity ->
            if (identity.value == peerId && matchesCall(reader.info.attributes)) receiverScope.launch {
                try {
                    val messageId = reader.info.attributes["messageId"] ?: reader.info.id
                    if (messageId.length !in 1..100) return@launch
                    val text = StringBuilder()
                    withTimeout(15_000.milliseconds) {
                        reader.flow.collect { part ->
                            if (text.length + part.length > MAX_TEXT_LENGTH) throw CallTextException(CallTextError.InvalidText)
                            text.append(part)
                        }
                    }
                    val playbackId = reader.info.attributes[SpeechPlaybackProtocol.PLAYBACK_ID]
                        ?.takeIf { reader.info.attributes[SpeechPlaybackProtocol.VERSION] == "1" && it.length in 1..100 }
                    if (playbackId != null) rememberAttempt(messageId, playbackId, replace = false)
                    if (text.isNotBlank()) {
                        emit(CallMediaEvent.TextReceived(callId, messageId, text.toString(), playbackId))
                        if (playbackId != null) sendControl(messageId, playbackId,
                            CallTextPlayback(playbackId, nextSequence(playbackId)))
                    }
                } catch (_: Exception) {
                    currentCoroutineContext().ensureActive()
                    emit(CallMediaEvent.PlaybackStatus(callId, true))
                }
            }
        }
        room.registerByteStreamHandler(AUDIO_TOPIC) { reader, identity ->
            if (identity.value == peerId && matchesCall(reader.info.attributes) && reader.info.mimeType == "audio/pcm") receiverScope.launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    val messageId = reader.info.attributes["messageId"] ?: reader.info.id
                    require(messageId.length in 1..100)
                    val info = SpeechPlaybackProtocol.segment(reader.info.attributes)
                    if (info != null) rememberAttempt(messageId, info.playbackId, replace = true)
                    val audio = IncomingAudio(reader, messageId, info)
                    if (incomingAudio.trySend(audio).isFailure) {
                        if (info != null) publishProgress(messageId, CallTextPlayback(info.playbackId,
                            nextSequence(info.playbackId), status = CallTextPlaybackStatus.Interrupted))
                        emit(CallMediaEvent.PlaybackStatus(callId, true))
                        drain(reader)
                    }
                } catch (_: Exception) {
                    currentCoroutineContext().ensureActive()
                    emit(CallMediaEvent.PlaybackStatus(callId, true))
                    drain(reader)
                }
            }
        }
    }

    private fun nextSequence(id: String) = sequences.getOrPut(id) { AtomicLong() }.incrementAndGet()
    private fun rememberAttempt(messageId: String, id: String, replace: Boolean) = synchronized(messageAttempts) {
        if (replace || messageAttempts[messageId] == null) messageAttempts[messageId] = id
        while (messageAttempts.size > 200) {
            val key = messageAttempts.keys.first()
            messageAttempts.remove(key)?.let { sequences.remove(it) }
        }
    }

    private suspend fun playIncoming(audio: IncomingAudio) {
        val info = audio.info
        if (info == null) {
            try { emit(CallMediaEvent.PlaybackStatus(callId, false)); PcmSpeechPlayer().play(audio.reader.flow) }
            catch (_: Exception) { currentCoroutineContext().ensureActive(); emit(CallMediaEvent.PlaybackStatus(callId, true)) }
            return
        }
        if (synchronized(cancelledAttempts) { info.playbackId in cancelledAttempts }) { drain(audio.reader); return }
        val updates = Channel<CallTextPlayback>(Channel.CONFLATED)
        val acknowledgements = Channel<CallTextPlayback>(Channel.CONFLATED)
        // A slow acknowledgement must never block AudioTrack writes or local caption display.
        receiverScope.launch {
            for (progress in acknowledgements) {
                sendControl(audio.messageId, progress.playbackId, progress)
                if (progress.status == CallTextPlaybackStatus.Playing) delay(100.milliseconds)
            }
        }
        val localUpdates = receiverScope.launch {
            try {
                for (progress in updates) {
                    emit(CallMediaEvent.TextPlayback(callId, audio.messageId, CallSpeaker.Remote, progress))
                    acknowledgements.trySend(progress)
                }
            } finally { acknowledgements.close() }
        }
        val lastEnd = AtomicInteger(info.start)
        var completed = false
        var lastPublished = -1
        try {
            emit(CallMediaEvent.PlaybackStatus(callId, false))
            PcmSpeechPlayer().play(audio.reader.flow, info.bytes) { frames ->
                val end = info.spokenTextEnd(frames)
                lastEnd.set(end)
                if (end != lastPublished) {
                    updates.trySend(CallTextPlayback(info.playbackId, nextSequence(info.playbackId), end, CallTextPlaybackStatus.Playing))
                    lastPublished = end
                }
            }
            completed = true
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { emit(CallMediaEvent.PlaybackStatus(callId, true)) }
        finally {
            withContext(NonCancellable) {
                if (!closed.get()) updates.trySend(CallTextPlayback(info.playbackId, nextSequence(info.playbackId), lastEnd.get(),
                    if (!completed) CallTextPlaybackStatus.Interrupted else if (info.last) CallTextPlaybackStatus.Completed else CallTextPlaybackStatus.Playing))
                updates.close()
                localUpdates.join()
            }
        }
    }

    private suspend fun publishProgress(messageId: String, progress: CallTextPlayback) {
        emit(CallMediaEvent.TextPlayback(callId, messageId, CallSpeaker.Remote, progress))
        sendControl(messageId, progress.playbackId, progress)
    }

    private suspend fun sendControl(messageId: String, playbackId: String, progress: CallTextPlayback?) {
        try {
            withTimeoutOrNull(500.milliseconds) {
                withContext(Dispatchers.Main.immediate) {
                    if (!closed.get() && room.state == Room.State.CONNECTED) room.localParticipant.publishData(
                        SpeechPlaybackProtocol.encode(callId, messageId, playbackId, progress),
                        topic = SpeechPlaybackProtocol.TOPIC, identities = listOf(Participant.Identity(peerId)),
                    ).getOrThrow()
                }
            }
        } catch (_: Exception) { currentCoroutineContext().ensureActive() }
    }

    private suspend fun drain(reader: ByteStreamReceiver) {
        try { withTimeout(180_000.milliseconds) { reader.flow.collect { } } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { }
    }

    private fun matchesCall(attributes: Map<String, String>) = !closed.get() &&
        (attributes["callId"] == null || attributes["callId"] == callId)

    suspend fun sendText(messageId: String, text: String, playbackId: String) = sending {
        withContext(Dispatchers.Main.immediate) {
            requireConnected()
            room.localParticipant.sendText(text, StreamTextOptions(
                topic = TEXT_TOPIC,
                attributes = mapOf("callId" to callId, "messageId" to messageId,
                    SpeechPlaybackProtocol.VERSION to "1", SpeechPlaybackProtocol.PLAYBACK_ID to playbackId),
                destinationIdentities = listOf(Participant.Identity(peerId)),
            )).getOrThrow()
        }
    }

    suspend fun sendSpeech(messageId: String, playbackId: String, segments: Flow<CallSpeechSegment>) = sending {
        var totalBytes = 0L
        var previousEnd: Int? = null
        segments.collect { segment ->
            val boundary = previousEnd
            if (boundary != null && playbackFeedback.value[playbackId] != null) {
                val progress = playbackFeedback.first { feedback ->
                    val current = feedback[playbackId]
                    current != null && (current.spokenTextEnd >= boundary || current.status == CallTextPlaybackStatus.Interrupted)
                }.getValue(playbackId)
                if (progress.status == CallTextPlaybackStatus.Interrupted) throw CallTextException(CallTextError.AudioDelivery)
            }
            totalBytes += segment.pcm.size
            if (segment.pcm.isEmpty() || segment.pcm.size % 2 != 0 || totalBytes > PcmSpeechPlayer.MAX_PCM_BYTES) {
                throw CallTextException(CallTextError.InvalidAudio)
            }
            var writer: ByteStreamSender? = null
            var completed = false
            try {
                withContext(Dispatchers.Main.immediate) {
                    requireConnected()
                    writer = room.localParticipant.streamBytes(StreamBytesOptions(
                        topic = AUDIO_TOPIC, mimeType = "audio/pcm", name = "speech.pcm", streamId = UUID.randomUUID().toString(),
                        attributes = SpeechPlaybackProtocol.attributes(callId, messageId, playbackId, segment),
                        destinationIdentities = listOf(Participant.Identity(peerId)), compress = false,
                    ))
                }
                val sender = checkNotNull(writer)
                var offset = 0
                while (offset < segment.pcm.size) {
                    currentCoroutineContext().ensureActive()
                    val end = minOf(offset + 16_384, segment.pcm.size)
                    sender.write(segment.pcm.copyOfRange(offset, end)).getOrThrow()
                    offset = end
                }
                sender.close()
                completed = true
                previousEnd = segment.textStart + segment.text.length
            } finally {
                if (!completed) withContext(NonCancellable) {
                    try { withTimeoutOrNull(1_000.milliseconds) { writer?.close(reason = "TTS stream failed") } }
                    catch (_: Exception) { /* Preserve the original send error/cancellation. */ }
                }
            }
        }
        if (totalBytes == 0L) throw CallTextException(CallTextError.InvalidAudio)
    }

    suspend fun cancelSpeech(messageId: String, playbackId: String) = sendControl(messageId, playbackId, null)

    private suspend fun <T> sending(block: suspend () -> T): T = coroutineScope {
        val job = checkNotNull(currentCoroutineContext()[Job])
        synchronized(sendJobs) {
            if (closed.get()) throw CallTextException(CallTextError.CallUnavailable)
            sendJobs.add(job)
        }
        try { withTimeout(180_000.milliseconds) { block() } }
        finally { synchronized(sendJobs) { sendJobs.remove(job) } }
    }

    private fun requireConnected() {
        if (closed.get() || room.state != Room.State.CONNECTED || room.localParticipant.isMicrophoneEnabled ||
            room.remoteParticipants.values.none { it.identity?.value == peerId }) throw CallTextException(CallTextError.CallUnavailable)
    }

    suspend fun close() {
        if (!closed.compareAndSet(false, true)) return
        room.unregisterTextStreamHandler(TEXT_TOPIC)
        room.unregisterByteStreamHandler(AUDIO_TOPIC)
        incomingAudio.cancel()
        receiverJob.cancel()
        val pending = synchronized(sendJobs) { sendJobs.toList() }
        pending.forEach { it.cancel() }
        pending.forEach { it.join() }
        receiverJob.join()
    }

    companion object {
        const val TEXT_TOPIC = "kick-chat-text"
        const val AUDIO_TOPIC = "kick-speech-pcm"
        const val MAX_TEXT_LENGTH = 10_000
    }
}
