package com.ssafy.vomi.core.data.call

import com.ssafy.vomi.core.network.model.voice.CreateSpeechRequest
import com.ssafy.vomi.core.network.model.voice.VoiceResponse
import com.ssafy.vomi.core.network.service.voice.VoiceClient
import com.ssafy.vomi.core.network.service.voice.VoiceService
import com.ssafy.vomi.core.network.service.voice.VoiceSpeechService
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.ResponseBody

/** Existing signaling checks must never synthesize paid audio. */
internal fun unusedVoiceClient() = VoiceClient(
    object : VoiceService {
        override suspend fun getVoice(): VoiceResponse = error("Unused in signaling checks")
        override suspend fun registerVoice(audio: MultipartBody.Part, consent: RequestBody): VoiceResponse = error("Unused in signaling checks")
    },
    object : VoiceSpeechService {
        override suspend fun streamSpeech(request: CreateSpeechRequest): ResponseBody = error("Unused in signaling checks")
    },
)
