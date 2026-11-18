package com.ssafy.vomi.core.network.service.voice

import com.ssafy.vomi.core.network.model.voice.CreateSpeechRequest
import okhttp3.ResponseBody
import retrofit2.http.Body
import retrofit2.http.POST
import retrofit2.http.Streaming

interface VoiceSpeechService {
    @Streaming
    @POST("api/voice/speech/stream")
    suspend fun streamSpeech(@Body request: CreateSpeechRequest): ResponseBody
}
