package com.ssafy.vomi.feature.home.impl

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

    @Test fun enteringHomeLoadsFriendsAndKeepsTheSignedInUser() {
        val auth = Auth()
        val friends = Friends().apply { pending = CompletableDeferred() }
        val vm = HomeViewModel(auth, friends)
        assertEquals(HomeUiState.Loading, vm.uiState.value)
        assertEquals(1, friends.requests)
        friends.pending!!.complete(Unit)
        val state = vm.uiState.value as HomeUiState.Success
        assertEquals(friends.friends, state.friends)
        assertEquals(auth.user, state.currentUser)
        assertEquals("kick-test-2", state.friends.single().id)
    }

    @Test fun emptyResponseShowsEmptySuccessWithoutSampleFriends() {
        val vm = HomeViewModel(Auth(), Friends().apply { friends = emptyList() })
        assertTrue((vm.uiState.value as HomeUiState.Success).friends.isEmpty())
    }

    @Test fun failureShowsErrorAndRetryGoesThroughLoadingToFreshSuccess() {
        val failure = IOException("offline")
        val friends = Friends().apply { this.failure = failure }
        val vm = HomeViewModel(Auth(), friends)
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
        val vm = HomeViewModel(Auth(), friends)
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
}
