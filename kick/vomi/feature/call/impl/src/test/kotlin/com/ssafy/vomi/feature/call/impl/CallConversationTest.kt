package com.ssafy.vomi.feature.call.impl

import com.ssafy.vomi.feature.call.impl.model.CallPhase
import com.ssafy.vomi.feature.call.impl.model.sampleCallState
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallConversationTest {
    private val state = MutableStateFlow(sampleCallState("kick-test-2", "친구"))
    private val conversation = CallConversation(state)

    @Test fun microphoneOnBlocksEditingAndOutgoingRequestsWithoutLosingDraft() {
        conversation.updateDraft("작성 중인 답변")
        val original = state.value.messages
        state.value = state.value.copy(isMicrophoneEnabled = true)
        conversation.updateDraft("바뀌면 안 되는 답변")
        conversation.selectSuggestion(1L)
        assertEquals("작성 중인 답변", state.value.draft)
        assertNull(conversation.draftToSend())
        assertNull(conversation.suggestionToSend(1L))
        assertNull(conversation.backchannelToSend(1L))
        assertFalse(state.value.canType)
        state.value = state.value.copy(isMicrophoneEnabled = false)
        assertTrue(state.value.canType)
        assertEquals("작성 중인 답변", conversation.draftToSend())
        assertEquals(original, state.value.messages)
    }

    @Test fun suggestionEditsDraftAndRequestsNeverInventDeliveredMessages() {
        val original = state.value.messages
        conversation.selectSuggestion(1L)
        val reply = state.value.suggestions.first().text
        assertEquals(reply, state.value.draft)
        assertEquals(reply, conversation.draftToSend())
        assertEquals(reply, conversation.suggestionToSend(1L))
        assertEquals(original, state.value.messages)
    }

    @Test fun freeTextCanExceedTwentyCharactersAndWhitespaceIsNotRequested() {
        conversation.updateDraft("   ")
        assertNull(conversation.draftToSend())
        val text = "오늘은 시간이 조금 어려워서 내일 저녁에 다시 연락드려도 괜찮을까요?"
        conversation.updateDraft(text)
        assertEquals(text, conversation.draftToSend())
    }

    @Test fun quickRepliesKeepDraftAndAreBlockedDuringSendOrAfterEnding() {
        conversation.updateDraft("따로 작성하던 답변")
        assertEquals(state.value.backchannels.first().text, conversation.backchannelToSend(1L))
        assertEquals(state.value.suggestions.last().text, conversation.suggestionToSend(3L))
        assertEquals("따로 작성하던 답변", state.value.draft)
        state.value = state.value.copy(isSendingText = true)
        assertNull(conversation.backchannelToSend(1L))
        assertNull(conversation.suggestionToSend(1L))
        state.value = state.value.copy(isSendingText = false, phase = CallPhase.Ended)
        assertNull(conversation.suggestionToSend(1L))
    }
}
