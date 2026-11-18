package com.ssafy.vomi.core.data.call

import android.icu.text.BreakIterator
import com.ssafy.vomi.core.model.call.CallTextError
import com.ssafy.vomi.core.model.call.CallTextException
import java.util.Locale

/** The server limits each request to 50 graphemes. Keep the entire message and split audio requests only. */
internal fun speechTextParts(text: String): List<String> {
    val result = mutableListOf<String>()
    var remaining = text.trim()
    while (remaining.isNotEmpty()) {
        val iterator = BreakIterator.getCharacterInstance(Locale.KOREAN).apply { setText(remaining) }
        var boundary = iterator.first()
        repeat(50) {
            val next = iterator.next()
            if (next != BreakIterator.DONE) boundary = next
        }
        if (boundary <= 0) throw CallTextException(CallTextError.InvalidText)
        var end = boundary
        if (end < remaining.length) {
            val separator = remaining.substring(0, end).indexOfLast { it.isWhitespace() || it in ".!?。" }
            if (separator >= end / 2) end = separator + 1
        }
        val part = remaining.substring(0, end).trim()
        if (part.length > 1_000) throw CallTextException(CallTextError.InvalidText)
        if (part.isNotEmpty()) result.add(part)
        remaining = remaining.substring(end).trimStart()
    }
    return result
}
