package com.ssafy.vomi.core.rtc

import com.ssafy.vomi.core.model.call.CallMediaEvent
import com.ssafy.vomi.core.model.call.CallTextError
import com.ssafy.vomi.core.model.call.CallTextException
import io.livekit.android.room.Room
import io.livekit.android.room.datastream.StreamBytesOptions
import io.livekit.android.room.datastream.StreamTextOptions
import io.livekit.android.room.datastream.incoming.ByteStreamReceiver
import io.livekit.android.room.datastream.outgoing.ByteStreamSender
import io.livekit.android.room.participant.Participant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.CoroutineContext
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

/** One instance per Room. Handlers are installed before connect and all children end with that Room. */
internal class RtcTextStreams(
    private val callId: String,
    private val peerId: String,
    private val room: Room,
    parentContext: CoroutineContext,
    private val emit: suspend (CallMediaEvent) -> Unit,
) {
    private val closed = AtomicBoolean(false)
    private val receiverJob = SupervisorJob(parentContext[Job])
    private val receiverScope = CoroutineScope(parentContext + receiverJob + Dispatchers.IO)
    private val sendJobs = mutableSetOf<Job>()
    private val incomingAudio = Channel<ByteStreamReceiver>(4)

    init {
        receiverScope.launch {
            for (reader in incomingAudio) {
                try {
                    emit(CallMediaEvent.PlaybackStatus(callId, false))
                    PcmSpeechPlayer().play(reader.flow)
                } catch (_: Exception) {
                    currentCoroutineContext().ensureActive()
                    emit(CallMediaEvent.PlaybackStatus(callId, true))
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
                    if (text.isNotBlank()) emit(CallMediaEvent.TextReceived(callId, messageId, text.toString()))
                } catch (_: Exception) {
                    currentCoroutineContext().ensureActive()
                    emit(CallMediaEvent.PlaybackStatus(callId, true))
                }
            }
        }
        room.registerByteStreamHandler(AUDIO_TOPIC) { reader, identity ->
            if (identity.value == peerId && matchesCall(reader.info.attributes) && reader.info.mimeType == "audio/pcm") {
                if (incomingAudio.trySend(reader).isFailure && !closed.get()) receiverScope.launch {
                    emit(CallMediaEvent.PlaybackStatus(callId, true))
                    // Drain a rejected stream so it does not retain the SDK's buffered payload.
                    try { withTimeout(180_000.milliseconds) { reader.flow.collect { } } }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { }
                }
            }
        }
    }

    private fun matchesCall(attributes: Map<String, String>) = !closed.get() &&
        (attributes["callId"] == null || attributes["callId"] == callId)

    suspend fun sendText(messageId: String, text: String) = sending {
        withContext(Dispatchers.Main.immediate) {
            requireConnected()
            room.localParticipant.sendText(text, StreamTextOptions(
                topic = TEXT_TOPIC,
                attributes = mapOf("callId" to callId, "messageId" to messageId),
                destinationIdentities = listOf(Participant.Identity(peerId)),
            )).getOrThrow()
        }
    }

    suspend fun sendSpeech(messageId: String, chunks: Flow<ByteArray>) = sending {
        var writer: ByteStreamSender? = null
        var completed = false
        try {
            withContext(Dispatchers.Main.immediate) {
                requireConnected()
                writer = room.localParticipant.streamBytes(StreamBytesOptions(
                    topic = AUDIO_TOPIC,
                    mimeType = "audio/pcm",
                    name = "speech.pcm",
                    streamId = UUID.randomUUID().toString(),
                    attributes = mapOf("callId" to callId, "messageId" to messageId),
                    destinationIdentities = listOf(Participant.Identity(peerId)),
                    compress = false,
                ))
            }
            val sender = checkNotNull(writer)
            var bytes = 0L
            chunks.collect { chunk ->
                currentCoroutineContext().ensureActive()
                bytes += chunk.size
                if (bytes > PcmSpeechPlayer.MAX_PCM_BYTES) throw CallTextException(CallTextError.InvalidAudio)
                sender.write(chunk).getOrThrow()
            }
            if (bytes == 0L || bytes % 2 != 0L) throw CallTextException(CallTextError.InvalidAudio)
            sender.close()
            completed = true
        } finally {
            if (!completed) withContext(NonCancellable) {
                try { withTimeoutOrNull(1_000.milliseconds) { writer?.close(reason = "TTS stream failed") } }
                catch (_: Exception) { /* Preserve the original send error/cancellation. */ }
            }
        }
    }

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
            room.remoteParticipants.values.none { it.identity?.value == peerId }) {
            throw CallTextException(CallTextError.CallUnavailable)
        }
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
