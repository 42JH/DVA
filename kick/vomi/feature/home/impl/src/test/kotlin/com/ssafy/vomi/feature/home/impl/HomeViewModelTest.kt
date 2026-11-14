package com.ssafy.vomi.feature.home.impl

import com.ssafy.vomi.core.data.repository.CallRepository
import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallSignalingState
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.CallStatus
import com.ssafy.vomi.core.data.repository.AuthRepository
import com.ssafy.vomi.core.data.repository.FriendRepository
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.model.auth.UserSession
import com.ssafy.vomi.core.model.friend.Friend
import com.ssafy.vomi.feature.home.impl.model.HomeUiState
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
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

    private class Auth : AuthRepository {
        val user = UserSession("kick-test-1", "테스트 계정 1", TestAccount.User1)
        override val currentUser = MutableStateFlow<UserSession?>(user)
        override fun login(account: TestAccount): Flow<UserSession> = error("Unused")
        override fun logout() { currentUser.value = null }
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
        override val state = MutableStateFlow(CallSignalingState(accountId = "kick-test-1", connection = CallConnection.Connected))
        val requests = mutableListOf<Pair<String, String>>()
        var failure: Exception? = null
        var pending: CompletableDeferred<Unit>? = null
        var retries = 0
        override fun setForeground(foreground: Boolean) { }
        override fun retryConnection() { retries++ }
        override fun createCall(calleeId: String, requestId: String): Flow<CallSession> = flow {
            requests += calleeId to requestId
            pending?.await(); failure?.let { throw it }
            emit(CallSession(requestId, "kick-test-1", calleeId, CallStatus.REQUESTED))
        }
        override fun acceptCall(callId: String): Flow<Unit> = error("Unused")
        override fun declineOrEndCall(callId: String): Flow<Unit> = error("Unused")
    }
    private fun home(auth: Auth, friends: Friends, calls: Calls = Calls()) = HomeViewModel(auth, friends, calls)

    @Test fun enteringHomeLoadsFriendsAndKeepsTheSignedInUser() {
        val auth = Auth()
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
        val vm = home(Auth(), Friends().apply { friends = emptyList() })
        assertTrue((vm.uiState.value as HomeUiState.Success).friends.isEmpty())
    }

    @Test fun failureShowsErrorAndRetryGoesThroughLoadingToFreshSuccess() {
        val failure = IOException("offline")
        val friends = Friends().apply { this.failure = failure }
        val vm = home(Auth(), friends)
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
        val vm = home(Auth(), friends)
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
        val vm = home(Auth(), Friends(), calls)
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
        val calls = Calls().apply { state.value = state.value.copy(connection = CallConnection.Failed) }
        val vm = home(Auth(), Friends(), calls)
        vm.callFriend("kick-test-2")
        assertTrue(calls.requests.isEmpty())
        vm.retryCallConnection()
        assertEquals(1, calls.retries)
    }
}
