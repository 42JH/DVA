package com.ssafy.vomi.feature.call.impl

import com.ssafy.vomi.core.model.call.CallTextSendProgress
import com.ssafy.vomi.core.data.repository.CallRepository
import com.ssafy.vomi.core.model.call.CallMediaState
import com.ssafy.vomi.core.model.call.CallSnapshot
import com.ssafy.vomi.core.data.repository.FriendRepository
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.data.repository.CallTranscriptRepository
import com.ssafy.vomi.core.model.call.CallCaption
import com.ssafy.vomi.core.model.call.CallMessageDelivery
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.core.model.call.CallTranscriptState
import com.ssafy.vomi.core.data.repository.SpeechRepository
import com.ssafy.vomi.core.model.speech.SpeechState
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallSignalingState
import com.ssafy.vomi.core.model.call.CallStatus
import com.ssafy.vomi.core.model.friend.Friend
import com.ssafy.vomi.feature.call.impl.model.CallPhase
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CallViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private class Calls(incoming: Boolean = false, creating: Boolean = false) : CallRepository {
        val accountId = if (incoming) "kick-test-2" else "kick-test-1"
        override val callState = MutableStateFlow(
            CallSignalingState(
                accountId = accountId,
                session = CallSession("call-1", "kick-test-1", "kick-test-2", CallStatus.REQUESTED),
                connection = CallConnection.Connected,
                isCreating = creating,
            ),
        )
        private val retryRequests = MutableStateFlow(0L)
        override val reconnectRequests: Flow<Unit> = retryRequests.map { Unit }
        override fun beginSession(userId: String) { callState.value = CallSignalingState(accountId = userId) }
        override fun clearSession() { callState.value = CallSignalingState() }
        override fun retryConnection() { retryRequests.value++ }
        val actions = mutableListOf<String>()
        var pending: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        override fun createCall(calleeId: String, requestId: String): Flow<CallSession> = error("Unused")
        override fun getActiveCall(): Flow<CallSnapshot> = flow { emit(CallSnapshot(accountId, callState.value.session)) }
        override fun getCall(callId: String): Flow<CallSession> = error("Unused")
        override fun observeCalls(): Flow<CallSnapshot> = error("Unused")
        override fun observeMedia(): Flow<CallMediaState> = error("Unused")
        override fun sendTextAudio(callId: String, messageId: String, text: String): Flow<CallTextSendProgress> = error("Unused")
        override fun setMicrophoneEnabled(callId: String, enabled: Boolean): Flow<Unit> = flow {
            callState.value = callState.value.copy(media = callState.value.media.copy(isMicrophoneEnabled = enabled))
            emit(Unit)
        }
        override fun acceptCall(callId: String) = action("accept", CallStatus.ACCEPTED)
        override fun rejectCall(callId: String) = action("reject", CallStatus.REJECTED)
        override fun cancelCall(callId: String) = action("cancel", CallStatus.CANCELED)
        override fun endCall(callId: String) = action("end", CallStatus.ENDED)
        private fun action(name: String, status: CallStatus): Flow<CallSession> = flow {
            actions += name; pending?.await(); failure?.let { throw it }
            val session = callState.value.session!!.copy(status = status)
            callState.value = callState.value.copy(session = session)
            emit(session)
        }
    }
    private class Friends(var failure: Boolean = false) : FriendRepository {
        override fun getFriends(): Flow<List<Friend>> = flow {
            if (failure) throw IOException("offline")
            emit(listOf(Friend("kick-test-1", "사용자1"), Friend("kick-test-2", "사용자2")))
        }
    }

    private class Captions : SpeechRepository {
        override val speechState = MutableStateFlow(SpeechState())
        override fun observeCall(callId: String, peerId: String, microphoneEnabled: Flow<Boolean>): Flow<Unit> = error("Unused")
        override fun downloadKoreanModel(): Flow<Unit> = error("Unused")
        override fun retryRecognition() = Unit
        override fun clearSession() = Unit
    }

    private class Transcript : CallTranscriptRepository {
        override val transcriptState = MutableStateFlow(CallTranscriptState())
        override fun beginCall(callId: String) = Unit
        override fun clearSession() = Unit
        override fun applyCaption(speaker: CallSpeaker, caption: CallCaption) = Unit
        override fun discardPartialCaptions(callId: String) = Unit
        override fun putText(callId: String, messageId: String, speaker: CallSpeaker, text: String, delivery: CallMessageDelivery) = Unit
        override fun setTextDelivery(callId: String, messageId: String, delivery: CallMessageDelivery) = Unit
        override fun setPlaybackError(callId: String, failed: Boolean) = Unit
    }

    @Test fun outgoingUsesServerCallIdAndDoesNotInventMessagesOrAnActiveMediaConnection() {
        val calls = Calls()
        val vm = CallViewModel(calls, Friends(), Captions(), Transcript()).apply { initialize("call-1") }
        assertEquals(CallPhase.Outgoing, vm.uiState.value.phase)
        assertEquals("사용자2", vm.uiState.value.friendName)
        assertTrue(vm.uiState.value.messages.isEmpty())
        assertTrue(vm.uiState.value.suggestions.isEmpty())
        assertNull(vm.uiState.value.summary)
        assertTrue(vm.uiState.value.backchannels.isNotEmpty())
        vm.toggleMicrophone(); vm.updateDraft("아직 전송하지 않음"); vm.selectBackchannel(1L)
        assertEquals(0L, vm.uiState.value.elapsedSeconds)
        assertFalse(vm.uiState.value.isMicrophoneEnabled)
        assertEquals("", vm.uiState.value.draft)
        assertTrue(vm.uiState.value.messages.isEmpty())
    }

    @Test fun acceptIsGuardedAndAcceptedWaitsForTheFutureMediaLayer() {
        val calls = Calls(incoming = true).apply { pending = CompletableDeferred() }
        val vm = CallViewModel(calls, Friends(), Captions(), Transcript()).apply { initialize("call-1") }
        assertEquals(CallPhase.Incoming, vm.uiState.value.phase)
        vm.acceptIncoming(); vm.acceptIncoming(); vm.endCall()
        assertTrue(vm.uiState.value.isActionPending)
        assertEquals(listOf("accept"), calls.actions)
        calls.pending!!.complete(Unit)
        assertEquals(CallPhase.Accepted, vm.uiState.value.phase)
        assertFalse(vm.uiState.value.canType)
        assertEquals(0L, vm.uiState.value.elapsedSeconds)
    }

    @Test fun failedDeclineKeepsIncomingScreenAndAllowsRetry() {
        val calls = Calls(incoming = true).apply { failure = IOException("offline") }
        val vm = CallViewModel(calls, Friends(), Captions(), Transcript()).apply { initialize("call-1") }
        vm.endCall()
        assertEquals(CallPhase.Incoming, vm.uiState.value.phase)
        assertTrue(vm.uiState.value.hasActionError)
        assertFalse(vm.uiState.value.isActionPending)
        calls.failure = null
        vm.endCall()
        assertEquals(CallPhase.Ended, vm.uiState.value.phase)
        assertFalse(vm.uiState.value.hasActionError)
    }

    @Test fun nullOrTerminalServerSnapshotClosesTheScreen() {
        val calls = Calls()
        val vm = CallViewModel(calls, Friends(), Captions(), Transcript()).apply { initialize("call-1") }
        calls.callState.value = calls.callState.value.copy(session = null)
        assertEquals(CallPhase.Ended, vm.uiState.value.phase)
        vm.endCall()
        assertTrue(calls.actions.isEmpty())
    }

    @Test fun nameLookupFailureUsesPeerIdAndReinitializationDoesNotSwitchCallIdentity() {
        val calls = Calls()
        val vm = CallViewModel(calls, Friends(failure = true), Captions(), Transcript()).apply { initialize("call-1") }
        assertEquals("kick-test-2", vm.uiState.value.friendName)
        vm.initialize("other-call")
        assertEquals("call-1", vm.uiState.value.callId)
    }
    @Test fun creationInFlightDisablesConflictingActionsUntilTheCreateCompletes() {
        val calls = Calls(creating = true)
        val vm = CallViewModel(calls, Friends(), Captions(), Transcript()).apply { initialize("call-1") }
        assertTrue(vm.uiState.value.isCreating)
        vm.endCall()
        assertTrue(calls.actions.isEmpty())
        calls.callState.value = calls.callState.value.copy(isCreating = false)
        vm.endCall()
        assertEquals(listOf("cancel"), calls.actions)
    }
}
