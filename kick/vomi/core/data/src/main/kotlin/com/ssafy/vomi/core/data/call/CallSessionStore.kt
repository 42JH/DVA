package com.ssafy.vomi.core.data.call

import com.ssafy.vomi.core.model.call.CallMediaConnection
import com.ssafy.vomi.core.model.call.CallMediaState
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallSignalingState
import com.ssafy.vomi.core.model.call.CallSnapshot
import com.ssafy.vomi.core.model.call.CallStatus
import java.io.IOException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Repository-internal state merging; no authentication, networking or background subscription. */
internal class CallSessionStore(
    private val elapsedRealtime: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private val lock = Any()
    private val mutableState = MutableStateFlow(CallSignalingState())
    val state = mutableState.asStateFlow()
    private val finishedIds = linkedSetOf<String>()

    fun beginSession(userId: String) = synchronized(lock) {
        finishedIds.clear()
        mutableState.value = CallSignalingState(accountId = userId)
    }

    fun clear() = synchronized(lock) {
        finishedIds.clear()
        mutableState.value = CallSignalingState()
    }

    fun setConnection(userId: String, connection: CallConnection) = synchronized(lock) {
        if (state.value.accountId == userId) mutableState.value = state.value.copy(connection = connection)
    }

    fun tryStartCreating(userId: String): Boolean = synchronized(lock) {
        if (state.value.accountId != userId || !state.value.canStartCall) false
        else { mutableState.value = state.value.copy(isCreating = true); true }
    }

    fun finishCreating(userId: String) = synchronized(lock) {
        if (state.value.accountId == userId) mutableState.value = state.value.copy(isCreating = false)
    }

    fun applySnapshot(snapshot: CallSnapshot, expectedUserId: String) = synchronized(lock) {
        if (state.value.accountId != expectedUserId) return@synchronized
        if (snapshot.accountId != expectedUserId) throw IOException("Call snapshot account mismatch")
        val session = snapshot.session
        if (session != null && session.callerId != expectedUserId && session.calleeId != expectedUserId) {
            throw IOException("Call participant mismatch")
        }
        if (session == null) {
            state.value.session?.let { rememberFinished(it.id) }
            mutableState.value = state.value.copy(session = null, media = CallMediaState(), startedAtElapsedRealtime = null)
        } else {
            state.value.session?.takeIf { it.id != session.id }?.let { rememberFinished(it.id) }
            mergeSession(session, expectedUserId)
        }
    }

    fun applyCall(session: CallSession, expectedUserId: String) = synchronized(lock) {
        if (state.value.accountId != expectedUserId) return@synchronized
        val current = state.value.session
        if (current == null || current.id == session.id || current.isTerminal) mergeSession(session, expectedUserId)
    }

    private fun mergeSession(session: CallSession, userId: String) {
        if (session.callerId != userId && session.calleeId != userId) throw IOException("Call participant mismatch")
        if (session.id in finishedIds && !session.isTerminal) return
        val previous = state.value.session
        if (previous?.id == session.id &&
            (previous.isTerminal || previous.status == CallStatus.ACCEPTED && session.status == CallStatus.REQUESTED)) return
        if (session.isTerminal) rememberFinished(session.id)
        val resetMedia = previous?.id != session.id || session.isTerminal
        mutableState.value = state.value.copy(
            session = session,
            media = if (resetMedia) CallMediaState() else state.value.media,
            startedAtElapsedRealtime = if (resetMedia) null else state.value.startedAtElapsedRealtime,
        )
    }

    fun applyMedia(media: CallMediaState, userId: String) = synchronized(lock) {
        val current = state.value
        if (current.accountId != userId || current.session?.id != media.callId ||
            current.session?.status != CallStatus.ACCEPTED) return@synchronized
        val firstConnectedAt = current.startedAtElapsedRealtime ?: if (
            media.connection == CallMediaConnection.Connected && media.isPeerConnected
        ) elapsedRealtime() else null
        mutableState.value = current.copy(media = media, startedAtElapsedRealtime = firstConnectedAt)
    }

    fun stopMedia(userId: String, callId: String) = synchronized(lock) {
        val current = state.value
        if (current.accountId == userId && current.media.callId == callId &&
            current.media.connection != CallMediaConnection.Failed) {
            mutableState.value = current.copy(media = CallMediaState(callId = callId))
        }
    }

    private fun rememberFinished(id: String) {
        finishedIds += id
        if (finishedIds.size > 64) finishedIds.remove(finishedIds.first())
    }
}
