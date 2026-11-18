package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.call.CallTextSendProgress
import com.ssafy.vomi.core.model.call.CallMediaState
import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallSignalingState
import com.ssafy.vomi.core.model.call.CallSnapshot
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

interface CallRepository {
    val callState: StateFlow<CallSignalingState>

    /** Emits initially and on a manual retry so the app can restart its foreground collector. */
    val reconnectRequests: Flow<Unit>

    fun beginSession(userId: String)
    fun clearSession()
    fun retryConnection()
    fun createCall(calleeId: String, requestId: String): Flow<CallSession>
    fun getActiveCall(): Flow<CallSnapshot>
    fun getCall(callId: String): Flow<CallSession>

    /** Refreshes current state, then receives events with automatic transient-error retries. */
    fun observeCalls(): Flow<CallSnapshot>

    /** App-owned collection controls the lifetime of the accepted call's media connection. */
    fun observeMedia(): Flow<CallMediaState>
    fun sendTextAudio(callId: String, messageId: String, text: String): Flow<CallTextSendProgress>
    fun setMicrophoneEnabled(callId: String, enabled: Boolean): Flow<Unit>

    fun acceptCall(callId: String): Flow<CallSession>
    fun rejectCall(callId: String): Flow<CallSession>
    fun cancelCall(callId: String): Flow<CallSession>
    fun endCall(callId: String): Flow<CallSession>
}
