package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.call.CallTextPlayback
import com.ssafy.vomi.core.model.call.CallCaption
import com.ssafy.vomi.core.model.call.CallMessageDelivery
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.core.model.call.CallTranscriptState
import kotlinx.coroutines.flow.StateFlow

/** Shared transcript ownership. Screens observe state; data producers apply voice/text events here. */
interface CallTranscriptRepository {
    val transcriptState: StateFlow<CallTranscriptState>
    fun beginCall(callId: String)
    fun clearSession()
    fun applyCaption(speaker: CallSpeaker, caption: CallCaption)
    fun discardPartialCaptions(callId: String)
    fun putText(callId: String, messageId: String, speaker: CallSpeaker, text: String, delivery: CallMessageDelivery, playbackId: String? = null)
    fun setTextDelivery(callId: String, messageId: String, delivery: CallMessageDelivery)
    fun beginTextPlayback(callId: String, messageId: String, playbackId: String)
    fun applyTextPlayback(callId: String, messageId: String, speaker: CallSpeaker, playback: CallTextPlayback)
    fun interruptTextPlaybacks(callId: String)
    fun setPlaybackError(callId: String, failed: Boolean)
}
