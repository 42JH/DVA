package com.ssafy.vomi.core.network.service.voice

import com.ssafy.vomi.core.network.model.voice.CreateSpeechRequest
import com.ssafy.vomi.core.network.model.voice.VoiceResponse
import java.io.File
import java.util.Locale
import javax.inject.Inject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody

class VoiceClient @Inject constructor(
    private val voiceService: VoiceService,
    private val speechService: VoiceSpeechService,
) {
    suspend fun getVoice(): VoiceResponse = voiceService.getVoice()

    suspend fun registerVoice(audio: File, consent: Boolean): VoiceResponse {
        require(consent) { "Voice registration requires the owner's consent" }
        require(audio.isFile && audio.length() in 1..MAX_AUDIO_BYTES) { "Audio must be between 1 byte and 10 MiB" }
        val mediaType = when (audio.extension.lowercase(Locale.ROOT)) {
            "mp3" -> "audio/mpeg"
            "wav" -> "audio/wav"
            else -> throw IllegalArgumentException("Audio must be an MP3 or WAV file")
        }.toMediaType()
        return voiceService.registerVoice(
            MultipartBody.Part.createFormData("audio", audio.name, audio.asRequestBody(mediaType)),
            "true".toRequestBody("text/plain".toMediaType()),
        )
    }

    /** Caller reads on an IO dispatcher and closes the body, including on cancellation. */
    suspend fun streamSpeech(text: String): ResponseBody =
        speechService.streamSpeech(CreateSpeechRequest(text))

    private companion object {
        const val MAX_AUDIO_BYTES = 10L * 1024 * 1024
    }
}
