package com.ssafy.vomi.core.data.reply

import org.json.JSONArray
import org.json.JSONException

/** Prefix-safe JSON parsing: incomplete escapes/UTF-16 pairs stay buffered instead of leaking into previews. */
internal class ReplyStreamParser {
    private val opening = Regex("""\{\s*"replies"\s*:\s*\[""")
    data class Candidate(val position: Int, val text: String, val isComplete: Boolean)

    fun parse(output: CharSequence): List<Candidate> {
        val start = opening.find(output) ?: return emptyList()
        val replies = mutableListOf<Candidate>()
        var position = start.range.last + 1
        repeat(3) { slot ->
            while (position < output.length && output[position].isWhitespace()) position++
            if (position >= output.length || output[position] != '"') return replies
            position++
            val raw = StringBuilder()
            var complete = false
            while (position < output.length) {
                val character = output[position]
                if (character == '"') { position++; complete = true; break }
                if (character == '\\') {
                    if (position + 1 >= output.length) break
                    val escaped = output[position + 1]
                    val size = if (escaped == 'u') 6 else 2
                    if (position + size > output.length) break
                    if (escaped == 'u') {
                        if (output.subSequence(position + 2, position + 6).any { it.digitToIntOrNull(16) == null }) {
                            throw JSONException("Invalid Unicode escape")
                        }
                    } else if (escaped !in "\"\\/bfnrt") throw JSONException("Invalid JSON escape")
                    raw.append(output, position, position + size)
                    position += size
                } else {
                    if (character.code < 0x20) throw JSONException("Invalid JSON string")
                    raw.append(character)
                    position++
                }
            }
            var decoded = JSONArray("[\"" + raw + "\"]").getString(0)
            if (!complete && decoded.lastOrNull()?.isHighSurrogate() == true) decoded = decoded.dropLast(1)
            val reply = spokenReply(decoded)
            if (reply.isNotEmpty() && reply.length <= 200) replies.add(Candidate(slot, reply, complete))
            if (!complete) return replies
            while (position < output.length && output[position].isWhitespace()) position++
            if (position >= output.length || output[position] != ',') return replies
            position++
        }
        return replies
    }
}
