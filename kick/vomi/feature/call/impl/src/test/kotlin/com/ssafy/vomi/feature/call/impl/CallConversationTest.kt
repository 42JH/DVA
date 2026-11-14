package com.ssafy.vomi.feature.call.impl

import com.ssafy.vomi.feature.call.impl.model.CallPhase
import com.ssafy.vomi.feature.call.impl.model.sampleCallState
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallConversationTest {
    private fun newCall(phase: CallPhase = CallPhase.Active) = CallConversation(MutableStateFlow(sampleCallState("kick-test-2", "친구").copy(phase = phase)))

    @Test
    fun microphoneOnBlocksEditingSendingAndSuggestionsWithoutLosingDraft() {
        val vm = newCall()
        vm.updateDraft("작성 중인 답변")
        val originalMessages = vm.uiState.value.messages
        vm.toggleMicrophone()
        vm.updateDraft("바뀌면 안 되는 답변")
        vm.selectSuggestion(1L)
        vm.sendDraft()
        assertEquals("작성 중인 답변", vm.uiState.value.draft)
        assertEquals(originalMessages, vm.uiState.value.messages)
        assertFalse(vm.uiState.value.canType)
        vm.toggleMicrophone()
        assertTrue(vm.uiState.value.canType)
        vm.sendDraft()
        assertEquals("작성 중인 답변", vm.uiState.value.messages.last().text)
        assertEquals("", vm.uiState.value.draft)
    }

    @Test
    fun suggestionOnlyFillsTheDraftUntilTheUserSendsIt() {
        val vm = newCall()
        val count = vm.uiState.value.messages.size
        vm.selectSuggestion(1L)
        assertEquals(count, vm.uiState.value.messages.size)
        assertEquals(vm.uiState.value.suggestions.first().text, vm.uiState.value.draft)
        vm.sendDraft()
        assertEquals(count + 1, vm.uiState.value.messages.size)
    }

    @Test
    fun freeTextCanExceedTwentyCharactersAndWhitespaceIsNotSent() {
        val vm = newCall()
        val count = vm.uiState.value.messages.size
        vm.updateDraft("   ")
        vm.sendDraft()
        assertEquals(count, vm.uiState.value.messages.size)
        val longReply = "오늘은 시간이 조금 어려워서 내일 저녁에 다시 연락드려도 괜찮을까요?"
        vm.updateDraft(longReply)
        vm.sendDraft()
        assertEquals(longReply, vm.uiState.value.messages.last().text)
    }

    @Test
    fun backchannelIsBlockedWithMicrophoneOnAndResumesWithoutLosingDraft() {
        val vm = newCall()
        vm.updateDraft("나중에 보낼 답변")
        val originalMessages = vm.uiState.value.messages
        val selectedBackchannel = vm.uiState.value.backchannels.first()
        vm.toggleMicrophone()
        vm.selectBackchannel(selectedBackchannel.id)
        assertEquals(originalMessages, vm.uiState.value.messages)
        assertEquals("나중에 보낼 답변", vm.uiState.value.draft)

        vm.toggleMicrophone()
        vm.selectBackchannel(selectedBackchannel.id)
        assertEquals(originalMessages.size + 1, vm.uiState.value.messages.size)
        assertEquals(selectedBackchannel.text, vm.uiState.value.messages.last().text)
        assertEquals("나중에 보낼 답변", vm.uiState.value.draft)
    }

    @Test
    fun tappingSuggestionSendsOneOriginalMessageAndKeepsTheExistingDraft() {
        val vm = newCall()
        val reply = vm.uiState.value.suggestions.last()
        vm.updateDraft("따로 작성하던 답변")
        val count = vm.uiState.value.messages.size
        vm.sendSuggestion(reply.id)
        assertEquals(count + 1, vm.uiState.value.messages.size)
        assertEquals(reply.text, vm.uiState.value.messages.last().text)
        assertEquals("따로 작성하던 답변", vm.uiState.value.draft)
    }

    @Test
    fun immediateSuggestionSendIsBlockedWithMicrophoneOnOrAfterEnding() {
        val vm = newCall()
        val messages = vm.uiState.value.messages
        vm.toggleMicrophone()
        vm.sendSuggestion(1L)
        assertEquals(messages, vm.uiState.value.messages)
        vm.toggleMicrophone()
        val ended = newCall(CallPhase.Ended)
        val endedMessages = ended.uiState.value.messages
        ended.sendSuggestion(1L)
        assertEquals(endedMessages, ended.uiState.value.messages)
    }
}
