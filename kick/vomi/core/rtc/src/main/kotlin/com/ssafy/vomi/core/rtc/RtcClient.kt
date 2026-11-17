package com.ssafy.vomi.core.rtc

import com.ssafy.vomi.core.model.call.CallMediaState
import kotlinx.coroutines.flow.Flow

interface RtcClient {
    /** Collecting owns one room; cancelling collection releases its audio and room resources. */
    fun connect(callId: String, serverUrl: String, token: String): Flow<CallMediaState>
    suspend fun setMicrophoneEnabled(callId: String, enabled: Boolean)
    suspend fun disconnect(callId: String)
}
