package com.ssafy.vomi.feature.home.impl

import com.ssafy.vomi.core.data.repository.CallRepository
import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallSignalingState
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.CallStatus
import com.ssafy.vomi.core.data.repository.UserRepository
import com.ssafy.vomi.core.model.call.CallSnapshot
import com.ssafy.vomi.core.data.repository.FriendRepository
import com.ssafy.vomi.core.model.user.UserProfile
import com.ssafy.vomi.core.model.friend.Friend
import com.ssafy.vomi.feature.home.impl.model.HomeUiState
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModelTest {
    @Before fun setupMain() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun resetMain() { Dispatchers.resetMain() }

    private class Users : UserRepository {
        val user = UserProfile("kick-test-1", "테스트 계정 1")
        override val currentUserProfile = MutableStateFlow<UserProfile?>(user)
        override fun getCurrentUser(): Flow<UserProfile> = flow { emit(user) }
        override fun clearCurrentUserProfile() { currentUserProfile.value = null }
    }
    private class Friends : FriendRepository {
        var requests = 0
        var pending: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        var friends = listOf(Friend("kick-test-2", "테스트 계정 2"))
        override fun getFriends(): Flow<List<Friend>> = flow {
            requests++
            pending?.await()
            failure?.let { throw it }
            emit(friends)
        }
    }

    private class Calls : CallRepository {
        override val callState = MutableStateFlow(CallSignalingState(accountId = "kick-test-1", connection = CallConnection.Connected))
        private val retryRequests = MutableStateFlow(0L)
        override val reconnectRequests: Flow<Unit> = retryRequests.map { Unit }
        val requests = mutableListOf<Pair<String, String>>()
        var failure: Exception? = null
        var pending: CompletableDeferred<Unit>? = null
        val retries: Int get() = retryRequests.value.toInt()
        override fun beginSession(userId: String) { callState.value = CallSignalingState(accountId = userId) }
        override fun clearSession() { callState.value = CallSignalingState() }
        override fun retryConnection() { retryRequests.value++ }
        override fun createCall(calleeId: String, requestId: String): Flow<CallSession> = flow {
            callState.value = callState.value.copy(isCreating = true)
            try {
                requests += calleeId to requestId
                pending?.await(); failure?.let { throw it }
                val session = CallSession(requestId, "kick-test-1", calleeId, CallStatus.REQUESTED)
                callState.value = callState.value.copy(session = session)
                emit(session)
            } finally { callState.value = callState.value.copy(isCreating = false) }
        }
        override fun getActiveCall(): Flow<CallSnapshot> = error("Unused")
        override fun getCall(callId: String): Flow<CallSession> = error("Unused")
        override fun observeCalls(): Flow<CallSnapshot> = error("Unused")
        override fun acceptCall(callId: String): Flow<CallSession> = error("Unused")
        override fun rejectCall(callId: String): Flow<CallSession> = error("Unused")
        override fun cancelCall(callId: String): Flow<CallSession> = error("Unused")
        override fun endCall(callId: String): Flow<CallSession> = error("Unused")
    }
    private fun home(users: Users, friends: Friends, calls: Calls = Calls()) = HomeViewModel(users, friends, calls)

    @Test fun enteringHomeLoadsFriendsAndKeepsTheSignedInUser() {
        val auth = Users()
        val friends = Friends().apply { pending = CompletableDeferred() }
        val vm = home(auth, friends)
        assertEquals(HomeUiState.Loading, vm.uiState.value)
        assertEquals(1, friends.requests)
        friends.pending!!.complete(Unit)
        val state = vm.uiState.value as HomeUiState.Success
        assertEquals(friends.friends, state.friends)
        assertEquals(auth.user, state.currentUser)
        assertEquals("kick-test-2", state.friends.single().id)
    }

    @Test fun emptyResponseShowsEmptySuccessWithoutSampleFriends() {
        val vm = home(Users(), Friends().apply { friends = emptyList() })
        assertTrue((vm.uiState.value as HomeUiState.Success).friends.isEmpty())
    }

    @Test fun failureShowsErrorAndRetryGoesThroughLoadingToFreshSuccess() {
        val failure = IOException("offline")
        val friends = Friends().apply { this.failure = failure }
        val vm = home(Users(), friends)
        assertSame(failure, (vm.uiState.value as HomeUiState.Error).exception)
        friends.failure = null
        friends.pending = CompletableDeferred()
        vm.retry()
        assertEquals(HomeUiState.Loading, vm.uiState.value)
        friends.pending!!.complete(Unit)
        assertEquals(friends.friends, (vm.uiState.value as HomeUiState.Success).friends)
        assertEquals(2, friends.requests)
    }

    @Test fun retriesQueuedBeforeInitialLoadStartsDoNotDuplicateRequests() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val friends = Friends().apply { pending = CompletableDeferred() }
        val vm = home(Users(), friends)
        vm.retry()
        vm.retry()
        runCurrent()
        assertEquals(1, friends.requests)
        vm.retry()
        assertEquals(1, friends.requests)
        friends.pending!!.complete(Unit)
        runCurrent()
        assertTrue(vm.uiState.value is HomeUiState.Success)
    }
    @Test fun failedOutgoingRequestKeepsUuidOnRetryAndBlocksDuplicateTaps() {
        val calls = Calls().apply { failure = IOException("lost response") }
        val vm = home(Users(), Friends(), calls)
        vm.callFriend("kick-test-2")
        assertTrue((vm.uiState.value as HomeUiState.Success).callError)
        calls.failure = null; calls.pending = CompletableDeferred()
        vm.callFriend("kick-test-2"); vm.callFriend("kick-test-2")
        assertEquals("kick-test-2", (vm.uiState.value as HomeUiState.Success).callingFriendId)
        assertEquals(2, calls.requests.size)
        assertEquals(calls.requests[0], calls.requests[1])
        calls.pending!!.complete(Unit)
        assertNull((vm.uiState.value as HomeUiState.Success).callingFriendId)
        assertFalse((vm.uiState.value as HomeUiState.Success).callError)
    }

    @Test fun noOutgoingRequestStartsBeforeTheEventConnectionIsReady() {
        val calls = Calls().apply { callState.value = callState.value.copy(connection = CallConnection.Failed) }
        val vm = home(Users(), Friends(), calls)
        vm.callFriend("kick-test-2")
        assertTrue(calls.requests.isEmpty())
        vm.retryCallConnection()
        assertEquals(1, calls.retries)
    }
}
