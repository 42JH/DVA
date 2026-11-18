package com.ssafy.vomi.core.model.call

enum class CallTextPlaybackStatus { Queued, Playing, Completed, Interrupted }

/** UTF-16 text offset at a grapheme boundary. Character positions are estimated from PCM playback. */
data class CallTextPlayback(
    val playbackId: String,
    val sequence: Long = 0,
    val spokenTextEnd: Int = 0,
    val status: CallTextPlaybackStatus = CallTextPlaybackStatus.Queued,
)

/** One server synthesis part, buffered with a known duration before publishing raw PCM. */
data class CallSpeechSegment(
    val textStart: Int,
    val text: String,
    val pcm: ByteArray,
    val isLast: Boolean,
)
