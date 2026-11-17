package com.ssafy.vomi.core.speech

import com.ssafy.vomi.core.model.speech.PcmAudioFrame
import com.ssafy.vomi.core.model.speech.SpeechCapability
import com.ssafy.vomi.core.model.speech.SpeechDownloadEvent
import com.ssafy.vomi.core.model.speech.SpeechEvent
import kotlinx.coroutines.flow.Flow

interface SpeechClient {
    suspend fun capability(): SpeechCapability
    /** Recognizes the supplied RTC audio; never starts a second microphone capture. */
    fun recognize(audio: Flow<PcmAudioFrame>): Flow<SpeechEvent>
    fun downloadKoreanModel(): Flow<SpeechDownloadEvent>
}
