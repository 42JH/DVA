package com.ssafy.vomi.core.rtc

import android.content.Context
import com.ssafy.vomi.core.model.call.CallSpeechSegment
import com.ssafy.vomi.core.model.call.CallCaption
import com.ssafy.vomi.core.model.speech.PcmAudioFrame
import com.ssafy.vomi.core.model.speech.SpeechError
import com.ssafy.vomi.core.model.speech.SpeechException
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.Track
import livekit.org.webrtc.AudioTrackSink
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.selects.select
import com.ssafy.vomi.core.model.call.CallMediaConnection
import com.ssafy.vomi.core.model.call.CallMediaState
import dagger.hilt.android.qualifiers.ApplicationContext
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.room.datastream.DataStreamOptions
import com.ssafy.vomi.core.model.call.CallMediaEvent
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.util.flow
import java.io.IOException
import javax.inject.Inject
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

internal class LiveKitRtcClient @Inject constructor(
    @param:ApplicationContext private val context: Context,
) : RtcClient {
    // Room ownership/control operations run on Main; stream I/O and playback use their own dispatchers.
    private var activeRoom: ActiveRoom? = null

    override fun connect(callId: String, serverUrl: String, token: String, peerId: String): Flow<CallMediaEvent> = channelFlow {
        // Assign ownership inside the dispatcher hop so prompt cancellation cannot leak a created Room.
        var ownedRoom: ActiveRoom? = null
        var eventJob: Job? = null
        var microphoneJob: Job? = null
        var connectJob: Job? = null
        try {
            withContext(Dispatchers.Main.immediate) {
                check(activeRoom == null) { "A voice room is already connected" }
                val session = ActiveRoom(callId, LiveKit.create(context, RoomOptions(
                    dataStreamOptions = DataStreamOptions(maxPayloadByteLength = 8_000_000L),
                ))) { trySend(CallMediaEvent.Media(it)) }
                ownedRoom = session
                activeRoom = session
            }
            val session = checkNotNull(ownedRoom)
            withContext(Dispatchers.Main.immediate) {
                session.textStreams = RtcTextStreams(callId, peerId, session.room, this@channelFlow.coroutineContext) { send(it) }
            }
            eventJob = launch(Dispatchers.Main.immediate, start = CoroutineStart.UNDISPATCHED) {
                session.room.events.collect { event ->
                    when (event) {
                        is RoomEvent.Connected, is RoomEvent.Reconnected -> session.publish(CallMediaConnection.Connected)
                        is RoomEvent.Reconnecting -> session.publish(CallMediaConnection.Reconnecting)
                        is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected -> session.publish()
                        is RoomEvent.Disconnected -> {
                            session.publish(CallMediaConnection.Failed, microphoneEnabled = false, peerConnected = false)
                            session.stop.complete(Unit)
                        }
                        else -> Unit
                    }
                }
            }
            microphoneJob = launch(Dispatchers.Main.immediate, start = CoroutineStart.UNDISPATCHED) {
                session.room.localParticipant::isMicrophoneEnabled.flow.collect { enabled ->
                    if (!session.stop.isCompleted) session.publish(microphoneEnabled = enabled)
                }
            }
            connectJob = launch(Dispatchers.Main.immediate) {
                val connected = withTimeoutOrNull(30_000.milliseconds) {
                    session.room.connect(serverUrl, token, ConnectOptions(audio = false, video = false))
                    true
                } ?: false
                if (!connected) throw IOException("Voice room connection timed out")
                session.publish(CallMediaConnection.Connected)
            }
            session.stop.await()
        } finally {
            withContext(NonCancellable + Dispatchers.Main.immediate) {
                val session = ownedRoom
                if (session != null) {
                    session.stop.complete(Unit)
                    try {
                        connectJob?.cancelAndJoin()
                        eventJob?.cancelAndJoin()
                        microphoneJob?.cancelAndJoin()
                        try { session.textStreams?.close() }
                        finally {
                            session.detachAudioSinks()
                            session.room.release()
                        }
                    } finally {
                        if (activeRoom === session) activeRoom = null
                        session.closed.complete(Unit)
                    }
                }
            }
        }
    }.buffer(Channel.BUFFERED)

    override suspend fun setMicrophoneEnabled(callId: String, enabled: Boolean) {
        withContext(Dispatchers.Main.immediate) {
            val session = checkNotNull(activeRoom?.takeIf { it.callId == callId && !it.stop.isCompleted })
            check(session.room.state == Room.State.CONNECTED) { "Voice room is not connected" }
            check(session.room.localParticipant.setMicrophoneEnabled(enabled)) { "Microphone change failed" }
            val confirmed = withTimeoutOrNull(5_000.milliseconds) {
                session.room.localParticipant::isMicrophoneEnabled.flow.first { it == enabled }
                true
            } ?: false
            check(confirmed && activeRoom === session && !session.stop.isCompleted) { "Microphone state was not confirmed" }
            session.publish(microphoneEnabled = enabled)
        }
    }


    override fun observeLocalAudio(callId: String): Flow<PcmAudioFrame> = channelFlow {
        val session = withContext(Dispatchers.Main.immediate) { requireRoom(callId) }
        val failed = CompletableDeferred<SpeechException>()
        val sink = AudioTrackSink { buffer, bits, sampleRate, channels, frames, _ ->
            // The SDK may keep capture alive while muted. Never transcribe unpublished microphone audio.
            if (session.captureEnabled && session.room.localParticipant.isMicrophoneEnabled && !session.stop.isCompleted) {
                if (bits != 16 || sampleRate !in 8_000..192_000 || channels !in 1..8) {
                    failed.complete(SpeechException(SpeechError.AudioInputUnavailable))
                } else {
                    val source = buffer.duplicate()
                    val size = frames * channels * 2
                    if (size <= source.remaining() && size > 0) {
                        val copy = ByteArray(size)
                        source.get(copy)
                        if (trySend(PcmAudioFrame(copy, sampleRate, channels)).isFailure) {
                            failed.complete(SpeechException(SpeechError.AudioInputUnavailable))
                        }
                    }
                }
            }
        }
        val tracks = launch(Dispatchers.Main.immediate) {
            session.room.localParticipant::audioTrackPublications.flow
                .map { publications -> publications.firstOrNull { (publication, _) -> publication.source == Track.Source.MICROPHONE }?.second as? LocalAudioTrack }
                .distinctUntilChanged()
                .collect { track -> session.attachAudioSink(sink, track) }
        }
        try {
            select<Unit> {
                session.stop.onAwait { }
                failed.onAwait { throw it }
            }
        } finally {
            withContext(NonCancellable + Dispatchers.Main.immediate) {
                tracks.cancelAndJoin()
                session.attachAudioSink(sink, null)
            }
        }
    }.buffer(100)

    override fun observeCaptions(callId: String, peerId: String): Flow<CallCaption> = channelFlow {
        val session = withContext(Dispatchers.Main.immediate) { requireRoom(callId) }
        val events = launch(Dispatchers.Main.immediate, start = CoroutineStart.UNDISPATCHED) {
            session.room.events.collect { event ->
                if (event is RoomEvent.DataReceived && event.topic == CallCaptionCodec.TOPIC &&
                    event.participant?.identity?.value == peerId) {
                    CallCaptionCodec.decode(event.data, callId)?.let { send(it) }
                }
            }
        }
        try { session.stop.await() }
        finally { withContext(NonCancellable) { events.cancelAndJoin() } }
    }.buffer(64)

    override suspend fun publishCaption(callId: String, peerId: String, caption: CallCaption) {
        withContext(Dispatchers.Main.immediate) {
            val session = requireRoom(callId)
            check(session.room.state == Room.State.CONNECTED && caption.callId == callId)
            session.room.localParticipant.publishData(
                data = CallCaptionCodec.encode(caption),
                topic = CallCaptionCodec.TOPIC,
                identities = listOf(Participant.Identity(peerId)),
            ).getOrThrow()
        }
    }

    private fun requireRoom(callId: String) = checkNotNull(
        activeRoom?.takeIf { it.callId == callId && !it.stop.isCompleted },
    ) { "The voice room is no longer active" }

    override suspend fun sendText(callId: String, messageId: String, text: String, playbackId: String) {
        val streams = withContext(Dispatchers.Main.immediate) { checkNotNull(requireRoom(callId).textStreams) }
        streams.sendText(messageId, text, playbackId)
    }

    override suspend fun sendSpeech(callId: String, messageId: String, playbackId: String, segments: Flow<CallSpeechSegment>) {
        val streams = withContext(Dispatchers.Main.immediate) { checkNotNull(requireRoom(callId).textStreams) }
        streams.sendSpeech(messageId, playbackId, segments)
    }

    override suspend fun cancelSpeech(callId: String, messageId: String, playbackId: String) {
        val streams = withContext(Dispatchers.Main.immediate) { requireRoom(callId).textStreams }
        streams?.cancelSpeech(messageId, playbackId)
    }

    override suspend fun disconnect(callId: String) {
        val session = withContext(Dispatchers.Main.immediate) {
            activeRoom?.takeIf { it.callId == callId }?.also { it.stop.complete(Unit) }
        }
        session?.closed?.await()
    }

    private class ActiveRoom(
        val callId: String,
        val room: Room,
        private val emit: (CallMediaState) -> Unit,
    ) {
        var textStreams: RtcTextStreams? = null
        val stop = CompletableDeferred<Unit>()
        val closed = CompletableDeferred<Unit>()
        @Volatile var captureEnabled = false
            private set
        private val audioSinks = mutableMapOf<AudioTrackSink, LocalAudioTrack>()

        fun attachAudioSink(sink: AudioTrackSink, track: LocalAudioTrack?) {
            val previous = audioSinks.remove(sink)
            if (previous === track) {
                if (track != null) audioSinks[sink] = track
                return
            }
            previous?.removeSink(sink)
            if (track != null && !stop.isCompleted) {
                track.addSink(sink)
                audioSinks[sink] = track
            }
        }

        fun detachAudioSinks() {
            captureEnabled = false
            audioSinks.forEach { (sink, track) -> track.removeSink(sink) }
            audioSinks.clear()
        }

        private var state = CallMediaState(callId, CallMediaConnection.Connecting)

        fun publish(
            connection: CallMediaConnection = state.connection,
            microphoneEnabled: Boolean = room.localParticipant.isMicrophoneEnabled,
            peerConnected: Boolean = room.remoteParticipants.isNotEmpty(),
        ) {
            state = CallMediaState(
                callId = callId,
                connection = connection,
                isPeerConnected = peerConnected,
                isMicrophoneEnabled = microphoneEnabled &&
                    (connection == CallMediaConnection.Connected || connection == CallMediaConnection.Reconnecting),
            )
            captureEnabled = state.isMicrophoneEnabled
            emit(state)
        }
    }
}
