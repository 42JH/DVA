package com.ssafy.vomi.core.data.call

import com.ssafy.vomi.core.model.call.CallCaption
import com.ssafy.vomi.core.model.speech.PcmAudioFrame
import com.ssafy.vomi.core.model.call.CallMediaEvent
import com.ssafy.vomi.core.rtc.RtcClient
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/** Existing signaling-only tests never connect media or access real SDK/audio resources. */
internal class FakeRtcClient : RtcClient {
    override fun connect(callId: String, serverUrl: String, token: String, peerId: String): Flow<CallMediaEvent> = flow { awaitCancellation() }
    override suspend fun setMicrophoneEnabled(callId: String, enabled: Boolean) = Unit
    override fun observeLocalAudio(callId: String): Flow<PcmAudioFrame> = flow { awaitCancellation() }
    override fun observeCaptions(callId: String, peerId: String): Flow<CallCaption> = flow { awaitCancellation() }
    override suspend fun publishCaption(callId: String, peerId: String, caption: CallCaption) = Unit
    override suspend fun sendText(callId: String, messageId: String, text: String) = Unit
    override suspend fun sendSpeech(callId: String, messageId: String, chunks: Flow<ByteArray>) = Unit
    override suspend fun disconnect(callId: String) = Unit
}
