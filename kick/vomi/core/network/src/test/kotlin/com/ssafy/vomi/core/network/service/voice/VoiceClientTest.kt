package com.ssafy.vomi.core.network.service.voice

import com.ssafy.vomi.core.network.model.voice.CreateSpeechRequest
import com.ssafy.vomi.core.network.model.voice.VoiceResponse
import java.io.File
import java.io.RandomAccessFile
import kotlinx.coroutines.runBlocking
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.ResponseBody
import org.junit.Assert.*
import org.junit.Test

class VoiceClientTest {
    @Test fun missingConsentInvalidFilesAndOversizeAudioNeverStartRegistration() = runBlocking {
        var uploads = 0
        val service = object : VoiceService {
            override suspend fun getVoice(): VoiceResponse = error("Unused")
            override suspend fun registerVoice(audio: MultipartBody.Part, consent: RequestBody): VoiceResponse {
                uploads++
                return VoiceResponse("CREATING")
            }
        }
        val speech = object : VoiceSpeechService {
            override suspend fun streamSpeech(request: CreateSpeechRequest): ResponseBody = error("Unused")
        }
        val client = VoiceClient(service, speech)
        val audio = File.createTempFile("voice-validation", ".wav")
        val wrongType = File.createTempFile("voice-validation", ".txt")
        try {
            expectInvalid { client.registerVoice(audio, consent = true) }
            audio.writeBytes(byteArrayOf(1))
            expectInvalid { client.registerVoice(audio, consent = false) }
            wrongType.writeBytes(byteArrayOf(1))
            expectInvalid { client.registerVoice(wrongType, consent = true) }
            RandomAccessFile(audio, "rw").use { it.setLength(10L * 1024 * 1024 + 1) }
            expectInvalid { client.registerVoice(audio, consent = true) }
            assertEquals(0, uploads)
        } finally { audio.delete(); wrongType.delete() }
    }

    private suspend fun expectInvalid(block: suspend () -> Unit) {
        try { block(); fail("Expected registration to be rejected before upload") }
        catch (_: IllegalArgumentException) { }
    }
}
