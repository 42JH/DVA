package com.ssafy.vomi.core.model.call

sealed interface CallMediaEvent {
    data class Media(val state: CallMediaState) : CallMediaEvent
    data class TextReceived(val callId: String, val messageId: String, val text: String, val playbackId: String? = null) : CallMediaEvent
    data class TextPlayback(val callId: String, val messageId: String, val speaker: CallSpeaker, val playback: CallTextPlayback) : CallMediaEvent
    data class PlaybackStatus(val callId: String, val hasError: Boolean) : CallMediaEvent
}
