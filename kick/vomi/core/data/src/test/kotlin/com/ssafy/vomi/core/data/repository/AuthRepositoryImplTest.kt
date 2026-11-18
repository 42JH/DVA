package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.data.auth.InMemoryAuthSessions
import com.ssafy.vomi.core.data.auth.LoginException
import com.ssafy.vomi.core.data.auth.SessionAccessTokenProvider
import com.ssafy.vomi.core.data.auth.MockAuthDataSource
import com.ssafy.vomi.core.datastore.copy
import com.ssafy.vomi.core.model.auth.AuthState
import com.ssafy.vomi.core.model.auth.LoginError
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.network.auth.UnauthenticatedRequest
import com.ssafy.vomi.core.network.model.account.AccountResponse
import com.ssafy.vomi.core.network.model.account.CreateAccountRequest
import com.ssafy.vomi.core.network.model.account.CreateAccountResponse
import com.ssafy.vomi.core.network.service.account.AccountClient
import com.ssafy.vomi.core.network.service.account.AccountService
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.single
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class AuthRepositoryImplTest {
    private class Service : AccountService {
        val headers = mutableListOf<String?>()
        var failure: Exception? = null
        var forcedId: String? = null
        override suspend fun createAccount(request: CreateAccountRequest, unauthenticated: UnauthenticatedRequest): CreateAccountResponse = error("Unused")
        override suspend fun getCurrentAccount(authorization: String?): AccountResponse {
            headers += authorization
            failure?.let { throw it }
            return AccountResponse(forcedId ?: if (authorization == "Bearer token-1") "kick-test-1" else "kick-test-2", "사용자")
        }
    }
    private val storage = InMemoryAuthSessions()
    private val provider = SessionAccessTokenProvider()

    @Test fun selectedAccountPersistsGenericUserIdAndBothTokens() = runTest {
        val service = Service()
        val repository = AuthRepositoryImpl(MockAuthDataSource(AccountClient(service), "token-1", "token-2"), storage.source, provider, StandardTestDispatcher(testScheduler))
        assertEquals("kick-test-1", repository.login(TestAccount.User1.accountId).single().userId)
        assertEquals("kick-test-1", (repository.authState.first() as AuthState.SignedIn).userId)
        assertEquals("token-1", storage.preferences.value.accessToken)
        assertEquals("mock-refresh-token", storage.preferences.value.refreshToken)
        assertEquals("token-1", provider.getAccessToken())
        repository.logout()
        repository.login(TestAccount.User2.accountId).single()
        assertEquals("kick-test-2", storage.preferences.value.userId)
        assertEquals(listOf("Bearer token-1", "Bearer token-2"), service.headers)
    }

    @Test fun aNewRepositoryRestoresTheSavedSessionAndTokenProvider() = runTest {
        storage.source.saveSession("saved-token", "saved-refresh", "server-user-id")
        val repository = AuthRepositoryImpl(MockAuthDataSource(AccountClient(Service()), "token-1", "token-2"), storage.source, provider, StandardTestDispatcher(testScheduler))
        assertEquals(AuthState.SignedIn("server-user-id"), repository.authState.first())
        assertEquals("saved-token", provider.getAccessToken())
    }

    @Test fun aMissingRefreshTokenIsSignedOutEvenWithAccessTokenAndUserId() = runTest {
        storage.preferences.value = storage.preferences.value.copy { accessToken = "token-1"; userId = "kick-test-1" }
        val repository = AuthRepositoryImpl(MockAuthDataSource(AccountClient(Service()), "token-1", "token-2"), storage.source, provider, StandardTestDispatcher(testScheduler))
        assertEquals(AuthState.SignedOut, repository.authState.first())
        assertNull(provider.getAccessToken())
    }

    @Test fun rejectedOrWrongAccountDoesNotReplaceTheSavedSession() = runTest {
        val service = Service()
        val repository = AuthRepositoryImpl(MockAuthDataSource(AccountClient(service), "token-1", "token-2"), storage.source, provider, StandardTestDispatcher(testScheduler))
        repository.login(TestAccount.User1.accountId).single()
        service.failure = HttpException(Response.error<AccountResponse>(401, "".toResponseBody()))
        try { repository.login(TestAccount.User2.accountId).single(); fail() }
        catch (error: HttpException) { assertEquals(401, error.code()) }
        assertEquals("kick-test-1", storage.preferences.value.userId)
        service.failure = null; service.forcedId = "kick-test-2"
        try { repository.login(TestAccount.User1.accountId).single(); fail() }
        catch (error: LoginException) { assertEquals(LoginError.UnexpectedAccount, error.reason) }
        assertEquals("token-1", provider.getAccessToken())
    }

    @Test fun missingTokenMakesNoRequest() = runTest {
        val service = Service()
        val repository = AuthRepositoryImpl(MockAuthDataSource(AccountClient(service), "", ""), storage.source, provider, StandardTestDispatcher(testScheduler))
        try { repository.login(TestAccount.User1.accountId).single(); fail() }
        catch (error: LoginException) { assertEquals(LoginError.MissingToken, error.reason) }
        assertTrue(service.headers.isEmpty())
        assertEquals(AuthState.SignedOut, repository.authState.first())
    }

    @Test fun networkFailureDoesNotSaveTokens() = runTest {
        val repository = AuthRepositoryImpl(MockAuthDataSource(AccountClient(Service().apply { failure = IOException("offline") }), "token-1", "token-2"), storage.source, provider, StandardTestDispatcher(testScheduler))
        try { repository.login(TestAccount.User1.accountId).single(); fail() }
        catch (error: IOException) { assertEquals("offline", error.message) }
        assertEquals(AuthState.SignedOut, repository.authState.first())
    }

    @Test fun cancellationRemainsCancellation() = runTest {
        val repository = AuthRepositoryImpl(MockAuthDataSource(AccountClient(Service().apply { failure = CancellationException("cancel") }), "token-1", "token-2"), storage.source, provider, StandardTestDispatcher(testScheduler))
        try { repository.login(TestAccount.User1.accountId).single(); fail() } catch (_: CancellationException) { }
        assertEquals(AuthState.SignedOut, repository.authState.first())
    }

    @Test fun loginIsColdAndLogoutClearsPersistentSessionAndProvider() = runTest {
        val service = Service()
        val repository = AuthRepositoryImpl(MockAuthDataSource(AccountClient(service), "token-1", "token-2"), storage.source, provider, StandardTestDispatcher(testScheduler))
        val login = repository.login(TestAccount.User1.accountId)
        assertTrue(service.headers.isEmpty())
        login.single(); repository.logout()
        assertEquals("", storage.preferences.value.accessToken)
        assertEquals("", storage.preferences.value.refreshToken)
        assertEquals("", storage.preferences.value.userId)
        assertNull(provider.getAccessToken())
        assertEquals(AuthState.SignedOut, repository.authState.first())
    }
}
