package com.ssafy.vomi.core.model.speech

/** A copied, interleaved signed PCM16 little-endian frame. No SDK or Android types escape RTC. */
data class PcmAudioFrame(val data: ByteArray, val sampleRate: Int, val channelCount: Int)
