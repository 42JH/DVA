package com.ssafy.vomi.feature.call.impl

import com.ssafy.vomi.core.data.repository.CallRepository
import com.ssafy.vomi.core.data.repository.FriendRepository
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
    private class Calls(incoming: Boolean = false) : CallRepository {
        override val state = MutableStateFlow(CallSignalingState(
            accountId = if (incoming) "kick-test-2" else "kick-test-1",
            session = CallSession("call-1", "kick-test-1", "kick-test-2", CallStatus.REQUESTED),
            connection = CallConnection.Connected,
        ))
        val actions = mutableListOf<String>()
        var pending: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        override fun setForeground(foreground: Boolean) { }
        override fun retryConnection() { }
        override fun createCall(calleeId: String, requestId: String): Flow<CallSession> = error("Unused")
        override fun acceptCall(callId: String): Flow<Unit> = action("accept", CallStatus.ACCEPTED)
        override fun declineOrEndCall(callId: String): Flow<Unit> = action("end", CallStatus.ENDED)
        private fun action(name: String, status: CallStatus): Flow<Unit> = flow {
            actions += name; pending?.await(); failure?.let { throw it }
            state.value = state.value.copy(session = state.value.session!!.copy(status = status))
            emit(Unit)
        }
    }
    private class Friends(var failure: Boolean = false) : FriendRepository {
        override fun getFriends(): Flow<List<Friend>> = flow {
            if (failure) throw IOException("offline")
            emit(listOf(Friend("kick-test-1", "사용자1"), Friend("kick-test-2", "사용자2")))
        }
    }

    @Test fun outgoingUsesServerCallIdAndDoesNotInventMessagesOrAnActiveMediaConnection() {
        val vm = CallViewModel(Calls(), Friends()).apply { initialize("call-1") }
        assertEquals(CallPhase.Outgoing, vm.uiState.value.phase)
        assertEquals("사용자2", vm.uiState.value.friendName)
        assertTrue(vm.uiState.value.messages.isEmpty())
        assertTrue(vm.uiState.value.suggestions.isEmpty())
        assertNull(vm.uiState.value.summary)
        assertTrue(vm.uiState.value.backchannels.isNotEmpty())
        vm.tick(); vm.toggleMicrophone(); vm.updateDraft("아직 전송하지 않음"); vm.selectBackchannel(1L)
        assertEquals(0L, vm.uiState.value.elapsedSeconds)
        assertFalse(vm.uiState.value.isMicrophoneEnabled)
        assertEquals("", vm.uiState.value.draft)
        assertTrue(vm.uiState.value.messages.isEmpty())
    }

    @Test fun acceptIsGuardedAndAcceptedWaitsForTheFutureMediaLayer() {
        val calls = Calls(incoming = true).apply { pending = CompletableDeferred() }
        val vm = CallViewModel(calls, Friends()).apply { initialize("call-1") }
        assertEquals(CallPhase.Incoming, vm.uiState.value.phase)
        vm.acceptIncoming(); vm.acceptIncoming(); vm.endCall()
        assertTrue(vm.uiState.value.isActionPending)
        assertEquals(listOf("accept"), calls.actions)
        calls.pending!!.complete(Unit)
        assertEquals(CallPhase.Accepted, vm.uiState.value.phase)
        assertFalse(vm.uiState.value.canType)
        vm.tick()
        assertEquals(0L, vm.uiState.value.elapsedSeconds)
    }

    @Test fun failedDeclineKeepsIncomingScreenAndAllowsRetry() {
        val calls = Calls(incoming = true).apply { failure = IOException("offline") }
        val vm = CallViewModel(calls, Friends()).apply { initialize("call-1") }
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
        val vm = CallViewModel(calls, Friends()).apply { initialize("call-1") }
        calls.state.value = calls.state.value.copy(session = null)
        assertEquals(CallPhase.Ended, vm.uiState.value.phase)
        vm.endCall()
        assertTrue(calls.actions.isEmpty())
    }

    @Test fun nameLookupFailureUsesPeerIdAndReinitializationDoesNotSwitchCallIdentity() {
        val vm = CallViewModel(Calls(), Friends(failure = true)).apply { initialize("call-1") }
        assertEquals("kick-test-2", vm.uiState.value.friendName)
        vm.initialize("other-call")
        assertEquals("call-1", vm.uiState.value.callId)
    }
    @Test fun creationInFlightDisablesConflictingActionsUntilTheCreateCompletes() {
        val calls = Calls().apply { state.value = state.value.copy(isCreating = true) }
        val vm = CallViewModel(calls, Friends()).apply { initialize("call-1") }
        assertTrue(vm.uiState.value.isCreating)
        vm.endCall()
        assertTrue(calls.actions.isEmpty())
        calls.state.value = calls.state.value.copy(isCreating = false)
        vm.endCall()
        assertEquals(listOf("end"), calls.actions)
    }
}
