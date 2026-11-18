package com.ssafy.vomi.core.rtc

import android.icu.text.BreakIterator
import com.ssafy.vomi.core.model.call.CallSpeechSegment
import com.ssafy.vomi.core.model.call.CallTextPlayback
import com.ssafy.vomi.core.model.call.CallTextPlaybackStatus
import java.util.Locale
import kotlin.math.ceil
import org.json.JSONException
import org.json.JSONObject

/** Versioned metadata and small reliable acknowledgements. Never mix control bytes into raw PCM. */
internal object SpeechPlaybackProtocol {
    const val TOPIC = "vomi.call.tts-playback.v1"
    const val VERSION = "speechProgressVersion"
    const val PLAYBACK_ID = "speechPlaybackId"

    data class Packet(val messageId: String, val playbackId: String, val progress: CallTextPlayback?)

    class SegmentInfo(val playbackId: String, val start: Int, text: String, val bytes: Long, val last: Boolean) {
        private val ends = buildList {
            val iterator = BreakIterator.getCharacterInstance(Locale.KOREAN).apply { setText(text) }
            iterator.first()
            var end = iterator.next()
            while (end != BreakIterator.DONE) { add(end); end = iterator.next() }
        }

        // PCM has no character timestamps. Interpolate only within a known-duration synthesis part.
        fun spokenTextEnd(frames: Long): Int {
            if (frames <= 0 || ends.isEmpty()) return start
            val count = ceil(frames.coerceAtMost(bytes / 2).toDouble() * ends.size / (bytes / 2)).toInt().coerceIn(1, ends.size)
            return start + ends[count - 1]
        }
    }

    fun attributes(callId: String, messageId: String, playbackId: String, segment: CallSpeechSegment) = mapOf(
        "callId" to callId, "messageId" to messageId, VERSION to "1", PLAYBACK_ID to playbackId,
        "speechTextStart" to segment.textStart.toString(), "speechText" to segment.text,
        "speechPcmBytes" to segment.pcm.size.toString(), "speechLast" to segment.isLast.toString(),
    )

    fun segment(attributes: Map<String, String>): SegmentInfo? {
        if (attributes[VERSION] != "1") return null
        val id = attributes[PLAYBACK_ID]?.takeIf { it.length in 1..100 } ?: error("Invalid playback ID")
        val start = attributes["speechTextStart"]?.toIntOrNull() ?: error("Invalid text range")
        val text = attributes["speechText"] ?: error("Missing speech text")
        val bytes = attributes["speechPcmBytes"]?.toLongOrNull() ?: error("Missing PCM length")
        val last = attributes["speechLast"]?.toBooleanStrictOrNull() ?: error("Missing segment boundary")
        require(start in 0..10_000 && text.length in 1..1_000 && start + text.length <= 10_000)
        require(bytes in 2..PcmSpeechPlayer.MAX_PCM_BYTES && bytes % 2 == 0L)
        return SegmentInfo(id, start, text, bytes, last)
    }

    fun encode(callId: String, messageId: String, playbackId: String, progress: CallTextPlayback?): ByteArray =
        JSONObject().put("callId", callId).put("messageId", messageId).put("playbackId", playbackId)
            .put("kind", if (progress == null) "cancel" else "progress").apply {
                if (progress != null) {
                    put("sequence", progress.sequence); put("end", progress.spokenTextEnd); put("status", progress.status.name)
                }
            }.toString().toByteArray(Charsets.UTF_8).also { require(it.size <= 1_000) }

    fun decode(bytes: ByteArray, callId: String): Packet? {
        if (bytes.size > 1_000) return null
        return try {
            val json = JSONObject(bytes.toString(Charsets.UTF_8))
            if (json.opt("callId") != callId || json.opt("messageId") !is String || json.opt("playbackId") !is String) return null
            val messageId = json.getString("messageId"); val playbackId = json.getString("playbackId")
            if (messageId.length !in 1..100 || playbackId.length !in 1..100) return null
            val progress = when (json.opt("kind")) {
                "cancel" -> null
                "progress" -> {
                    if (json.opt("sequence") !is Number || json.opt("end") !is Number) return null
                    val sequence = json.getLong("sequence"); val end = json.getInt("end")
                    val status = CallTextPlaybackStatus.entries.find { it.name == json.opt("status") } ?: return null
                    if (sequence <= 0 || end !in 0..10_000 || status == CallTextPlaybackStatus.Queued && end != 0) return null
                    CallTextPlayback(playbackId, sequence, end, status)
                }
                else -> return null
            }
            Packet(messageId, playbackId, progress)
        } catch (_: JSONException) { null }
    }
}
