package com.ssafy.vomi.feature.call.impl.component

/**
 * Allows greedy wrapping between Korean syllables regardless of the device's word-break rules.
 * Use only for rendering. Drafts, speech, and accessibility must keep the original text.
 * Break hints are never added inside emoji, combining sequences, or before punctuation.
 */
internal fun String.withHangulWrapOpportunities(): String = buildString {
    this@withHangulWrapOpportunities.forEachIndexed { index, character ->
        append(character)
        val next = this@withHangulWrapOpportunities.getOrNull(index + 1)
        if (character in '\uAC00'..'\uD7A3' && next != null && next in '\uAC00'..'\uD7A3') {
            append('\u200B')
        }
    }
}
