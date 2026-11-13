package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.data.auth.SessionAccessTokenProvider
import com.ssafy.vomi.core.data.auth.TestAccountCredentials
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.network.auth.AccessTokenInterceptor
import com.ssafy.vomi.core.network.di.NetworkModule
import com.ssafy.vomi.core.network.service.account.AccountClient
import kotlinx.coroutines.flow.single
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import retrofit2.HttpException

/** Opt-in, read-only server checks through the same Retrofit and interceptor configuration as the app. */
class AuthRepositoryLiveTest {
    @Test fun bothRuntimeChoicesAndAutomaticHeadersAuthenticateTheirOwnAccount() = runTest {
        assumeTrue(System.getenv("VOMI_RUN_AUTH_LIVE_TESTS") == "1")
        val token1 = System.getenv("KICK_TEST_ACCOUNT_1_TOKEN").orEmpty()
        val token2 = System.getenv("KICK_TEST_ACCOUNT_2_TOKEN").orEmpty()
        require(token1.isNotBlank() && token2.isNotBlank()) { "Local test credentials are required" }
        val provider = SessionAccessTokenProvider()
        val http = NetworkModule.provideOkHttpClient(
            AccessTokenInterceptor(provider), NetworkModule.provideHttpLoggingInterceptor(),
        )
        val retrofit = NetworkModule.provideRetrofit(NetworkModule.provideJson(), http)
        val client = AccountClient(NetworkModule.provideAccountService(retrofit))
        val repository = AuthRepositoryImpl(client, TestAccountCredentials(token1, token2), provider)
        repository.login(TestAccount.User1).single()
        assertEquals("kick-test-1", repository.currentUser.value!!.id)
        assertTrue(provider.getAccessToken() == token1)
        assertEquals("kick-test-1", client.getCurrentAccount().id)
        // Verify that selecting user 2 preserves its explicit header while user 1 is still cached.
        repository.login(TestAccount.User2).single()
        assertEquals("kick-test-2", repository.currentUser.value!!.id)
        assertTrue(provider.getAccessToken() == token2)
        assertEquals("kick-test-2", client.getCurrentAccount().id)
        repository.logout()
        assertTrue(provider.getAccessToken() == null)
        try { client.getCurrentAccount(); fail("Expected HTTP 401 after logout") }
        catch (e: HttpException) { assertEquals(401, e.code()) }
    }
}
