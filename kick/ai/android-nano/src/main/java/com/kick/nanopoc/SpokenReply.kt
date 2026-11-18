package com.kick.nanopoc

private val emoji = Regex(
    """[0-9#*]\uFE0F?\u20E3|[\x{1F000}-\x{1FAFF}\x{E0020}-\x{E007F}\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\uFE0E\uFE0F\u200D©®™]""",
)
private val chatEmoticon = Regex(
    """[ㅋㅎ]{2,}|[ㅠㅜ]{2,}|(?<!\S)[ㅋㅎㅠㅜ](?!\S)|\^{2,}|\^[_-]\^|[Ttㅠㅜ][_.-][Ttㅠㅜ]|[:;=][-^']?[()]|[:;=][-^']?[DPp](?![A-Za-z])|[♥♡]""",
)
private val extraWhitespace = Regex("""\s+""")
private val spaceBeforePunctuation = Regex(""" +([,.!?])""")

internal fun spokenReply(text: String): String =
    text.replace(emoji, "")
        .replace(chatEmoticon, "")
        .replace(extraWhitespace, " ")
        .replace(spaceBeforePunctuation, "$1")
        .trim()
        .takeIf { value -> value.any(Char::isLetterOrDigit) }
        .orEmpty()
