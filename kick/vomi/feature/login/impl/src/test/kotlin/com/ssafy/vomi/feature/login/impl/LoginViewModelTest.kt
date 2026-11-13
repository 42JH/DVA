package com.ssafy.vomi.feature.login.impl

import com.ssafy.vomi.core.data.repository.AuthRepository
import com.ssafy.vomi.core.data.auth.LoginException
import com.ssafy.vomi.core.model.auth.LoginError
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.model.auth.UserSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest {
    @Before fun setupMain() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun resetMain() { Dispatchers.resetMain() }

    private class Auth : AuthRepository {
        override val currentUser = MutableStateFlow<UserSession?>(null)
        val choices = mutableListOf<TestAccount>()
        var pending: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        override fun login(account: TestAccount): Flow<UserSession> = flow {
            choices += account
            pending?.await()
            failure?.let { throw it }
            currentUser.value = UserSession(account.accountId, "테스트 사용자", account)
            emit(requireNotNull(currentUser.value))
        }
        override fun logout() { currentUser.value = null }
    }

    @Test fun pendingLoginBlocksOtherButtonAndCompletesWithChosenAccount() {
        val auth = Auth().apply { pending = CompletableDeferred() }
        val vm = LoginViewModel(auth)
        vm.login(TestAccount.User1)
        assertEquals(TestAccount.User1, vm.uiState.value.loadingAccount)
        vm.login(TestAccount.User2)
        assertEquals(listOf(TestAccount.User1), auth.choices)
        auth.pending!!.complete(Unit)
        assertFalse(vm.uiState.value.isLoading)
        assertEquals(TestAccount.User1, auth.currentUser.value!!.account)
    }

    @Test fun failedLoginAllowsRetryWithTheOtherButton() {
        val auth = Auth().apply { failure = LoginException(LoginError.InvalidToken) }
        val vm = LoginViewModel(auth)
        vm.login(TestAccount.User1)
        assertEquals(LoginError.InvalidToken, vm.uiState.value.error)
        assertFalse(vm.uiState.value.isLoading)
        auth.failure = null
        vm.login(TestAccount.User2)
        assertEquals(TestAccount.User2, auth.currentUser.value!!.account)
        assertNull(vm.uiState.value.error)
    }

    @Test fun anUnexpectedFailureDoesNotLeaveButtonsLocked() {
        val vm = LoginViewModel(Auth().apply { failure = IllegalStateException("failure") })
        vm.login(TestAccount.User2)
        assertEquals(LoginError.Server, vm.uiState.value.error)
        assertFalse(vm.uiState.value.isLoading)
    }

    @Test fun tapsBeforeTheCoroutineStartsOnlyLaunchOneLogin() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val auth = Auth()
        val vm = LoginViewModel(auth)
        vm.login(TestAccount.User1)
        vm.login(TestAccount.User2)
        assertTrue(auth.choices.isEmpty())
        runCurrent()
        assertEquals(listOf(TestAccount.User1), auth.choices)
        assertEquals(TestAccount.User1, auth.currentUser.value!!.account)
    }
}
