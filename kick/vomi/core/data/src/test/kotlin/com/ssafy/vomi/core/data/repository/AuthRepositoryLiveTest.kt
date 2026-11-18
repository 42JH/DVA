package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.data.auth.InMemoryAuthSessions
import com.ssafy.vomi.core.model.auth.AuthState
import com.ssafy.vomi.core.data.auth.SessionAccessTokenProvider
import com.ssafy.vomi.core.data.auth.MockAuthDataSource
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.network.auth.AccessTokenInterceptor
import com.ssafy.vomi.core.network.di.NetworkModule
import com.ssafy.vomi.core.network.service.account.AccountClient
import com.ssafy.vomi.core.network.service.call.CallClient
import com.ssafy.vomi.core.network.service.call.CallEventsClient
import com.ssafy.vomi.core.network.service.friend.FriendClient
import com.ssafy.vomi.core.network.service.voice.VoiceClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.single
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import retrofit2.HttpException

/** Opt-in, read-only server checks through the same Retrofit and interceptor configuration as the app. */
class AuthRepositoryLiveTest {
    @Test fun bothRuntimeChoicesAndAutomaticHeadersAuthenticateTheirOwnAccount() = runBlocking {
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
        val repository = AuthRepositoryImpl(MockAuthDataSource(client, token1, token2), InMemoryAuthSessions().source, provider, Dispatchers.IO)
        val streamingHttp = NetworkModule.provideStreamingOkHttpClient(http)
        val streamingRetrofit = NetworkModule.provideStreamingRetrofit(retrofit, streamingHttp)
        val friends = FriendRepositoryImpl(FriendClient(NetworkModule.provideFriendService(retrofit)), Dispatchers.IO)
        val voice = VoiceClient(NetworkModule.provideVoiceService(retrofit), NetworkModule.provideVoiceSpeechService(streamingRetrofit))
        val calls = CallClient(NetworkModule.provideCallService(retrofit))
        val events = CallEventsClient(NetworkModule.provideCallEventService(streamingRetrofit), NetworkModule.provideJson(), Dispatchers.IO)
        repository.login(TestAccount.User1.accountId).single()
        assertEquals("kick-test-1", (repository.authState.first() as AuthState.SignedIn).userId)
        assertTrue(provider.getAccessToken() == token1)
        assertEquals("kick-test-1", client.getCurrentAccount().id)
        assertTrue(friends.getFriends().single().any { it.id == "kick-test-2" })
        assertTrue(voice.getVoice().status in setOf("READY", "NOT_REGISTERED", "CREATING", "VERIFICATION_REQUIRED"))
        assertEquals("kick-test-1", calls.getActiveCall().accountId)
        assertEquals("kick-test-1", withTimeout(10_000) { events.events().first() }.accountId)
        // Verify that selecting user 2 preserves its explicit header while user 1 is still cached.
        repository.login(TestAccount.User2.accountId).single()
        assertEquals("kick-test-2", (repository.authState.first() as AuthState.SignedIn).userId)
        assertTrue(provider.getAccessToken() == token2)
        assertEquals("kick-test-2", client.getCurrentAccount().id)
        assertTrue(friends.getFriends().single().any { it.id == "kick-test-1" })
        assertTrue(voice.getVoice().status in setOf("READY", "NOT_REGISTERED", "CREATING", "VERIFICATION_REQUIRED"))
        assertEquals("kick-test-2", calls.getActiveCall().accountId)
        assertEquals("kick-test-2", withTimeout(10_000) { events.events().first() }.accountId)
        repository.logout()
        assertTrue(provider.getAccessToken() == null)
        try { client.getCurrentAccount(); fail("Expected HTTP 401 after logout") }
        catch (e: HttpException) { assertEquals(401, e.code()) }
    }
}
