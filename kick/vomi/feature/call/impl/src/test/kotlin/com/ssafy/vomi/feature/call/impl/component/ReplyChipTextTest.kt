package com.ssafy.vomi.feature.call.impl.component

import com.ssafy.vomi.feature.call.impl.CallConversation
import com.ssafy.vomi.feature.call.impl.model.sampleCallState
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplyChipTextTest {
    @Test
    fun displayBreakHintsNeverLeakIntoTheDraftOrSentMessage() {
        val viewModel = CallConversation(MutableStateFlow(sampleCallState("kick-test-2", "친구")))
        val reply = viewModel.uiState.value.suggestions.last()
        val display = reply.text.withHangulWrapOpportunities()
        assertNotEquals(reply.text, display)
        assertEquals(reply.text, display.replace("\u200B", ""))

        viewModel.selectSuggestion(reply.id)
        assertEquals(reply.text, viewModel.uiState.value.draft)
        viewModel.sendDraft()
        assertEquals(reply.text, viewModel.uiState.value.messages.last().text)
    }

    @Test
    fun emojiCombiningSequencesAndExplicitNewlinesRemainIntact() {
        val family = "👩‍👩‍👧‍👦"
        val accented = "e\u0301"
        val decomposedHangul = "\u1112\u1161\u11AB"
        val source = "$family $accented $decomposedHangul\n말씀드릴게요."
        val display = source.withHangulWrapOpportunities()
        assertTrue(display.contains(family))
        assertTrue(display.contains(accented))
        assertTrue(display.contains(decomposedHangul))
        assertTrue(display.contains('\n'))
        assertEquals(source, display.replace("\u200B", ""))
    }
}
