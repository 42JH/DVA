package com.ssafy.vomi.core.data.call

import com.ssafy.vomi.core.model.call.CallMediaState
import com.ssafy.vomi.core.rtc.RtcClient
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/** Existing signaling-only tests never connect media or access real SDK/audio resources. */
internal class FakeRtcClient : RtcClient {
    override fun connect(callId: String, serverUrl: String, token: String): Flow<CallMediaState> = flow { awaitCancellation() }
    override suspend fun setMicrophoneEnabled(callId: String, enabled: Boolean) = Unit
    override suspend fun disconnect(callId: String) = Unit
}
