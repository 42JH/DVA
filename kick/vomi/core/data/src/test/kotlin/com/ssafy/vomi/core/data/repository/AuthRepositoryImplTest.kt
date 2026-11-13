package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.data.auth.TestAccountCredentials

import com.ssafy.vomi.core.data.auth.LoginException
import com.ssafy.vomi.core.model.auth.LoginError
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.network.service.account.AccountService
import com.ssafy.vomi.core.network.service.account.AccountClient
import com.ssafy.vomi.core.data.auth.SessionAccessTokenProvider
import com.ssafy.vomi.core.network.auth.UnauthenticatedRequest
import com.ssafy.vomi.core.network.model.account.CreateAccountRequest
import com.ssafy.vomi.core.network.model.account.CreateAccountResponse
import com.ssafy.vomi.core.network.model.account.AccountResponse
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.single
import kotlinx.coroutines.test.runTest
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class AuthRepositoryImplTest {
    private val credentials = TestAccountCredentials("token-user-1", "token-user-2")
    private val tokenProvider = SessionAccessTokenProvider()
    private fun newRepository(api: AccountService, credentials: TestAccountCredentials) =
        AuthRepositoryImpl(AccountClient(api), credentials, tokenProvider)
    private class Api : AccountService {
        override suspend fun createAccount(
            request: CreateAccountRequest,
            unauthenticated: UnauthenticatedRequest,
        ): CreateAccountResponse = error("Not used by test-account login")

        val headers = mutableListOf<String?>()
        var failure: Exception? = null
        var forcedId: String? = null
        override suspend fun getCurrentAccount(authorization: String?): AccountResponse {
            headers += authorization
            failure?.let { throw it }
            val id = if (authorization == "Bearer token-user-1") "kick-test-1" else "kick-test-2"
            return AccountResponse(forcedId ?: id, "테스트 사용자")
        }
    }
    private suspend fun expectFailure(reason: LoginError, action: suspend () -> Unit) {
        try { action(); fail("Expected login failure") }
        catch (e: LoginException) { assertEquals(reason, e.reason) }
    }

    @Test fun selectedButtonDeterminesBearerTokenAndSession() = runTest {
        val api = Api()
        val repository = newRepository(api, credentials)
        repository.login(TestAccount.User1).single()
        assertEquals("kick-test-1", repository.currentUser.value!!.id)
        assertEquals("token-user-1", tokenProvider.getAccessToken())
        repository.logout()
        repository.login(TestAccount.User2).single()
        assertEquals("kick-test-2", repository.currentUser.value!!.id)
        assertEquals(TestAccount.User2, repository.currentUser.value!!.account)
        assertEquals("token-user-2", tokenProvider.getAccessToken())
        assertEquals(listOf("Bearer token-user-1", "Bearer token-user-2"), api.headers)
    }

    @Test fun missingTokenDoesNotMakeARequestOrCreateASession() = runTest {
        val api = Api()
        val repository = newRepository(api, TestAccountCredentials("", ""))
        expectFailure(LoginError.MissingToken) { repository.login(TestAccount.User1).single() }
        assertTrue(api.headers.isEmpty())
        assertNull(repository.currentUser.value)
        assertNull(tokenProvider.getAccessToken())
    }

    @Test fun rejectedTokenDoesNotReplaceAnExistingSession() = runTest {
        val api = Api()
        val repository = newRepository(api, credentials)
        repository.login(TestAccount.User1).single()
        api.failure = HttpException(Response.error<AccountResponse>(401, "".toResponseBody()))
        expectFailure(LoginError.InvalidToken) { repository.login(TestAccount.User2).single() }
        assertEquals(TestAccount.User1, repository.currentUser.value!!.account)
        assertEquals("token-user-1", tokenProvider.getAccessToken())
    }

    @Test fun networkErrorsDoNotCreateASession() = runTest {
        val repository = newRepository(Api().apply { failure = IOException("offline") }, credentials)
        expectFailure(LoginError.Network) { repository.login(TestAccount.User1).single() }
        assertNull(repository.currentUser.value)
        assertNull(tokenProvider.getAccessToken())
    }

    @Test fun aTokenForTheOtherAccountIsRejected() = runTest {
        val repository = newRepository(Api().apply { forcedId = "kick-test-2" }, credentials)
        expectFailure(LoginError.UnexpectedAccount) { repository.login(TestAccount.User1).single() }
        assertNull(repository.currentUser.value)
        assertNull(tokenProvider.getAccessToken())
    }

    @Test fun cancellationIsNotConvertedToAUserFacingError() = runTest {
        val repository = newRepository(Api().apply { failure = CancellationException("cancel") }, credentials)
        try { repository.login(TestAccount.User1).single(); fail("Expected cancellation") }
        catch (e: CancellationException) { assertNull(repository.currentUser.value) }
    }

    @Test fun logoutClearsBothIdentityAndAccessToken() = runTest {
        val repository = newRepository(Api(), credentials)
        repository.login(TestAccount.User1).single()
        repository.logout()
        assertNull(repository.currentUser.value)
        assertNull(tokenProvider.getAccessToken())
    }

    @Test fun loginStartsOnlyWhenCollectedAndEmitsTheVerifiedSession() = runTest {
        val api = Api()
        val repository = newRepository(api, credentials)
        val result = repository.login(TestAccount.User1)
        assertTrue(api.headers.isEmpty())
        assertNull(repository.currentUser.value)
        val user = result.single()
        assertEquals("kick-test-1", user.id)
        assertEquals(user, repository.currentUser.value)
        assertEquals(listOf("Bearer token-user-1"), api.headers)
    }
}
