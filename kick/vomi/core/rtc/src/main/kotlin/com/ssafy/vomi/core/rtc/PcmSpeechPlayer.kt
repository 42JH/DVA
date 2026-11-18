package com.ssafy.vomi.core.rtc

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.ssafy.vomi.core.model.call.CallTextError
import com.ssafy.vomi.core.model.call.CallTextException
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/** Headerless 16 kHz PCM16 LE mono. Progress follows frames played, never frames merely written. */
internal class PcmSpeechPlayer {
    suspend fun play(chunks: Flow<ByteArray>, expectedBytes: Long? = null, onProgress: (Long) -> Unit = {}) = withContext(Dispatchers.IO) {
        val minimum = AudioTrack.getMinBufferSize(16_000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0) { "Call audio output is unavailable" }
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(16_000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(maxOf(minimum, 6_400)).build()
        var writtenBytes = 0L
        var carry: Byte? = null
        try {
            check(track.state == AudioTrack.STATE_INITIALIZED)
            track.play()
            withTimeout(180_000.milliseconds) {
                coroutineScope {
                    val progressJob = launch {
                        while (isActive) {
                            onProgress(track.playbackHeadPosition.toLong() and 0xffffffffL)
                            delay(40.milliseconds)
                        }
                    }
                    try {
                        chunks.collect { chunk ->
                            currentCoroutineContext().ensureActive()
                            val bytes = carry?.let { byteArrayOf(it) + chunk } ?: chunk
                            val evenLength = bytes.size - bytes.size % 2
                            carry = if (evenLength < bytes.size) bytes.last() else null
                            var offset = 0
                            while (offset < evenLength) {
                                currentCoroutineContext().ensureActive()
                                val count = track.write(bytes, offset, evenLength - offset, AudioTrack.WRITE_NON_BLOCKING)
                                if (count < 0) error("Call audio write failed")
                                if (count == 0) delay(10.milliseconds)
                                else { offset += count; writtenBytes += count }
                                if (writtenBytes > MAX_PCM_BYTES || expectedBytes != null && writtenBytes > expectedBytes) {
                                    throw CallTextException(CallTextError.InvalidAudio)
                                }
                            }
                        }
                        if (carry != null || writtenBytes == 0L || expectedBytes != null && expectedBytes != writtenBytes) {
                            throw CallTextException(CallTextError.InvalidAudio)
                        }
                        // Drain buffered samples before publishing completion or releasing output.
                        withTimeout(5_000.milliseconds) {
                            while ((track.playbackHeadPosition.toLong() and 0xffffffffL) < writtenBytes / 2) delay(10.milliseconds)
                        }
                    } finally { progressJob.cancelAndJoin() }
                    onProgress(track.playbackHeadPosition.toLong() and 0xffffffffL)
                }
            }
        } finally {
            try { if (track.playState == AudioTrack.PLAYSTATE_PLAYING) track.pause(); track.flush() }
            finally { track.release() }
        }
    }

    companion object { const val MAX_PCM_BYTES = 5_760_000L }
}
