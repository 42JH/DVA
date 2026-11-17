package com.ssafy.vomi.core.data.call

import com.ssafy.vomi.core.model.call.CallTextError
import com.ssafy.vomi.core.model.call.CallTextException
import com.ssafy.vomi.core.network.service.voice.VoiceClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch

internal fun serverSpeechStream(voiceClient: VoiceClient, parts: List<String>, ioDispatcher: CoroutineDispatcher): Flow<ByteArray> = flow {
    for (part in parts) emitAll(serverSpeechPart(voiceClient, part, ioDispatcher))
}

private fun serverSpeechPart(voiceClient: VoiceClient, text: String, ioDispatcher: CoroutineDispatcher): Flow<ByteArray> = channelFlow {
    val body = voiceClient.streamSpeech(text)
    try {
        val type = body.contentType()
        if (type?.type != "audio" || type.subtype != "pcm") throw CallTextException(CallTextError.InvalidAudio)
        val reader = launch(ioDispatcher) {
            try {
                var bytes = 0L
                body.byteStream().use { input ->
                    val buffer = ByteArray(4_096)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (count == 0) continue
                        bytes += count
                        if (bytes > 5_760_000L) throw CallTextException(CallTextError.InvalidAudio)
                        send(buffer.copyOf(count))
                    }
                }
                if (bytes == 0L || bytes % 2 != 0L) throw CallTextException(CallTextError.InvalidAudio)
                close()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { close(error) }
        }
        // Cancelling a coroutine does not interrupt a blocking HTTP body read. Close it before joining the reader.
        awaitClose { body.close(); reader.cancel() }
    } finally { body.close() }
}
