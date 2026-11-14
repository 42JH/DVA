package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallSignalingState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

interface CallRepository {
    val state: StateFlow<CallSignalingState>
    fun setForeground(foreground: Boolean)
    fun retryConnection()
    fun createCall(calleeId: String, requestId: String): Flow<CallSession>
    fun acceptCall(callId: String): Flow<Unit>
    fun declineOrEndCall(callId: String): Flow<Unit>
}
