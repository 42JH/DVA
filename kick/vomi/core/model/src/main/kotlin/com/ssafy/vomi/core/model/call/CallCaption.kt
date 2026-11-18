package com.ssafy.vomi.core.model.call

/** Revision is monotonic per utterance. An empty final cancels only an unfinished utterance. */
data class CallCaption(
    val callId: String,
    val utteranceId: String,
    val revision: Long,
    val text: String,
    val isFinal: Boolean,
)
