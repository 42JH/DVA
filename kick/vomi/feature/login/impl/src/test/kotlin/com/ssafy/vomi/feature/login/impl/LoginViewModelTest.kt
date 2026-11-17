package com.ssafy.vomi.feature.login.impl

import com.ssafy.vomi.core.data.repository.AuthRepository
import com.ssafy.vomi.core.data.auth.LoginException
import com.ssafy.vomi.core.model.auth.LoginError
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.model.auth.AuthState
import com.ssafy.vomi.core.model.auth.AuthLoginResult
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
        override val authState = MutableStateFlow<AuthState>(AuthState.SignedOut)
        val choices = mutableListOf<String>()
        var pending: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        override fun login(credential: String): Flow<AuthLoginResult> = flow {
            choices += credential
            pending?.await()
            failure?.let { throw it }
            authState.value = AuthState.SignedIn(credential)
            emit(AuthLoginResult(credential))
        }
        override suspend fun logout() { authState.value = AuthState.SignedOut }
    }

    @Test fun pendingLoginBlocksOtherButtonAndCompletesWithChosenAccount() {
        val auth = Auth().apply { pending = CompletableDeferred() }
        val vm = LoginViewModel(auth)
        vm.login(TestAccount.User1)
        assertEquals(TestAccount.User1, vm.uiState.value.loadingAccount)
        vm.login(TestAccount.User2)
        assertEquals(listOf(TestAccount.User1.accountId), auth.choices)
        auth.pending!!.complete(Unit)
        assertFalse(vm.uiState.value.isLoading)
        assertEquals(AuthState.SignedIn(TestAccount.User1.accountId), auth.authState.value)
    }

    @Test fun failedLoginAllowsRetryWithTheOtherButton() {
        val auth = Auth().apply { failure = LoginException(LoginError.InvalidToken) }
        val vm = LoginViewModel(auth)
        vm.login(TestAccount.User1)
        assertEquals(LoginError.InvalidToken, vm.uiState.value.error)
        assertFalse(vm.uiState.value.isLoading)
        auth.failure = null
        vm.login(TestAccount.User2)
        assertEquals(AuthState.SignedIn(TestAccount.User2.accountId), auth.authState.value)
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
        assertEquals(listOf(TestAccount.User1.accountId), auth.choices)
        assertEquals(AuthState.SignedIn(TestAccount.User1.accountId), auth.authState.value)
    }
}
