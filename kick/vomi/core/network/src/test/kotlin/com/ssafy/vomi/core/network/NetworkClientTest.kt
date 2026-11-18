package com.ssafy.vomi.core.network

import com.ssafy.vomi.core.network.auth.AccessTokenInterceptor
import com.ssafy.vomi.core.network.auth.AccessTokenProvider
import com.ssafy.vomi.core.network.di.NetworkModule
import com.ssafy.vomi.core.network.di.createHttpLoggingInterceptor
import com.ssafy.vomi.core.network.service.account.AccountClient
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.logging.HttpLoggingInterceptor
import org.junit.Assert.*
import org.junit.Test

class NetworkClientTest {
    private class Tokens(var value: String? = null) : AccessTokenProvider {
        override fun getAccessToken(): String? = value
    }
    private data class Fixture(val http: OkHttpClient, val client: AccountClient, val requests: MutableList<Request>)
    private fun fixture(
        tokens: Tokens,
        logger: HttpLoggingInterceptor = createHttpLoggingInterceptor(HttpLoggingInterceptor.Logger {}),
    ): Fixture {
        val requests = mutableListOf<Request>()
        val http = NetworkModule.provideOkHttpClient(AccessTokenInterceptor(tokens), logger).newBuilder()
            .addInterceptor { chain ->
                val request = chain.request()
                requests += request
                val id = if (request.header("Authorization") == "Bearer selected-b") "kick-test-2" else "kick-test-1"
                Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                    .body("""{"id":"$id","displayName":"테스트 사용자","extra":true}"""
                        .toResponseBody("application/json".toMediaType())).build()
            }.build()
        val retrofit = NetworkModule.provideRetrofit(NetworkModule.provideJson(), http)
        return Fixture(http, AccountClient(NetworkModule.provideAccountService(retrofit)), requests)
    }

    @Test fun sharedRetrofitPreservesKickPrefixAndParsesAccountResponse() = runTest {
        val fixture = fixture(Tokens("session-a"))
        val account = fixture.client.getCurrentAccount()
        assertEquals("kick-test-1", account.id)
        assertEquals("테스트 사용자", account.displayName)
        assertEquals(NetworkConfig.BASE_URL + "api/accounts/me", fixture.requests.single().url.toString())
        assertEquals("Bearer session-a", fixture.requests.single().header("Authorization"))
    }

    @Test fun explicitSelectedAccountTokenIsNotOverwrittenByCachedSession() = runTest {
        val tokens = Tokens("session-a")
        val fixture = fixture(tokens)
        assertEquals("kick-test-2", fixture.client.getCurrentAccount("selected-b").id)
        assertEquals("Bearer selected-b", fixture.requests.single().header("Authorization"))
        assertEquals("session-a", tokens.value)
    }

    @Test fun theSameClientReadsCurrentTokenAfterLoginSwitchAndLogout() {
        val tokens = Tokens()
        val fixture = fixture(tokens)
        for (token in listOf(null, "session-a", "session-b", "   ")) {
            tokens.value = token
            fixture.http.newCall(Request.Builder().url(NetworkConfig.BASE_URL + "api/accounts/me").build())
                .execute().use { assertTrue(it.isSuccessful) }
        }
        assertEquals(listOf(null, "Bearer session-a", "Bearer session-b", null),
            fixture.requests.map { it.header("Authorization") })
    }

    @Test fun sessionTokenIsNotAddedOutsideTheApiOriginAndPrefix() {
        val fixture = fixture(Tokens("session-a"))
        for (url in listOf(
            "https://other.example.com/kick/api/accounts/me",
            "http://3.37.162.168/kick/api/accounts/me",
            "https://3.37.162.168:444/kick/api/accounts/me",
            "https://3.37.162.168/other/api/accounts/me",
        )) {
            fixture.http.newCall(Request.Builder().url(url).build()).execute().use { assertTrue(it.isSuccessful) }
        }
        assertTrue(fixture.requests.all { it.header("Authorization") == null })
    }

    @Test fun loggingRedactsBothAutomaticAndExplicitAuthorizationHeaders() = runTest {
        val lines = mutableListOf<String>()
        val logger = createHttpLoggingInterceptor(HttpLoggingInterceptor.Logger { lines += it }).apply {
            level = HttpLoggingInterceptor.Level.HEADERS
        }
        val fixture = fixture(Tokens("session-a"), logger)
        fixture.client.getCurrentAccount()
        fixture.client.getCurrentAccount("selected-b")
        assertTrue(lines.any { it.contains("Authorization:", ignoreCase = true) })
        assertFalse(lines.any { it.contains("session-a") || it.contains("selected-b") })
    }
}
