package com.ssafy.vomi.core.network.service.voice

import com.ssafy.vomi.core.network.model.voice.VoiceResponse
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part

interface VoiceService {
    @GET("api/voice")
    suspend fun getVoice(): VoiceResponse

    @Multipart
    @POST("api/voice")
    suspend fun registerVoice(
        @Part audio: MultipartBody.Part,
        @Part("consent") consent: RequestBody,
    ): VoiceResponse
}
