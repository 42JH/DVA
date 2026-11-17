package com.ssafy.vomi.core.speech

private val questionEnding = Regex("""(?:냐(?:고|구)?|나요|까요|습니까|는지요)[.。…]*$""")
private val questionWord = Regex("""(?:^|\s)(?:무슨|어떤|어느|몇|얼마나|언제|어디(?:서|에|로)?|누구(?:랑|와|한테)?|왜|어떻게|뭐(?:를|가|랑)?)(?:\s|[.。…]*$)""")
private val conversationalEnding = Regex("""(?:었어|았어|였어|했어|했어요|었어요|았어요|예요|이에요)[.。…]*$""")
private val indirectQuestion = Regex("""(?:[는은을]지|냐고|다고|라고)\s|(?:모르겠어|알겠어|궁금했어|정했어)[.。…]*$""")

internal fun formatFinalSpeech(text: String): String {
    if (text.endsWith('?') || text.endsWith('？') || text.endsWith('!')) return text
    val isQuestion = questionEnding.containsMatchIn(text) ||
        (questionWord.containsMatchIn(text) && conversationalEnding.containsMatchIn(text) &&
            !indirectQuestion.containsMatchIn(text))
    return if (isQuestion) text.trimEnd('.', '。', '…') + "?" else text
}
