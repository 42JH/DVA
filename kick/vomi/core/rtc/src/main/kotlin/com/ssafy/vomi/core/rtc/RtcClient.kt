package com.ssafy.vomi.core.rtc

import com.ssafy.vomi.core.model.call.CallCaption
import com.ssafy.vomi.core.model.speech.PcmAudioFrame
import com.ssafy.vomi.core.model.call.CallMediaEvent
import kotlinx.coroutines.flow.Flow

interface RtcClient {
    /** Collecting owns one room; cancelling collection releases its audio and room resources. */
    fun connect(callId: String, serverUrl: String, token: String, peerId: String): Flow<CallMediaEvent>
    suspend fun setMicrophoneEnabled(callId: String, enabled: Boolean)
    fun observeLocalAudio(callId: String): Flow<PcmAudioFrame>
    fun observeCaptions(callId: String, peerId: String): Flow<CallCaption>
    suspend fun publishCaption(callId: String, peerId: String, caption: CallCaption)
    suspend fun sendText(callId: String, messageId: String, text: String)
    suspend fun sendSpeech(callId: String, messageId: String, chunks: Flow<ByteArray>)
    suspend fun disconnect(callId: String)
}
