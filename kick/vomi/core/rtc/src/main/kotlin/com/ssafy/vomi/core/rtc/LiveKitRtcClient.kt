package com.ssafy.vomi.core.rtc

import android.content.Context
import com.ssafy.vomi.core.model.call.CallMediaConnection
import com.ssafy.vomi.core.model.call.CallMediaState
import dagger.hilt.android.qualifiers.ApplicationContext
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
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
    // Room ownership and all SDK operations are serialized on the main dispatcher.
    private var activeRoom: ActiveRoom? = null

    override fun connect(callId: String, serverUrl: String, token: String): Flow<CallMediaState> = channelFlow {
        // Assign ownership inside the dispatcher hop so prompt cancellation cannot leak a created Room.
        var ownedRoom: ActiveRoom? = null
        var eventJob: Job? = null
        var microphoneJob: Job? = null
        var connectJob: Job? = null
        try {
            withContext(Dispatchers.Main.immediate) {
                check(activeRoom == null) { "A voice room is already connected" }
                val session = ActiveRoom(callId, LiveKit.create(context)) { trySend(it) }
                ownedRoom = session
                activeRoom = session
            }
            val session = checkNotNull(ownedRoom)
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
                    try {
                        connectJob?.cancelAndJoin()
                        eventJob?.cancelAndJoin()
                        microphoneJob?.cancelAndJoin()
                        session.room.release()
                    } finally {
                        if (activeRoom === session) activeRoom = null
                        session.closed.complete(Unit)
                    }
                }
            }
        }
    }.buffer(Channel.CONFLATED)

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
        val stop = CompletableDeferred<Unit>()
        val closed = CompletableDeferred<Unit>()
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
            emit(state)
        }
    }
}
