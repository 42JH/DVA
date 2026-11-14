package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.model.auth.UserSession
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.CallStatus
import com.ssafy.vomi.core.network.auth.AccessTokenInterceptor
import com.ssafy.vomi.core.network.auth.AccessTokenProvider
import com.ssafy.vomi.core.network.di.NetworkModule
import com.ssafy.vomi.core.network.model.call.CallAction
import com.ssafy.vomi.core.network.service.account.AccountClient
import com.ssafy.vomi.core.network.service.call.CallClient
import com.ssafy.vomi.core.network.service.call.CallEventsClient
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.single
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Reuses the production repository, Retrofit and SSE reader. Live writes require a separate opt-in. */
class CallSignalingIntegrationTest {
    private class Auth(account: TestAccount) : AuthRepository {
        override val currentUser = MutableStateFlow<UserSession?>(UserSession(account.accountId, account.accountId, account))
        override fun login(account: TestAccount): Flow<UserSession> = error("Prevalidated fixture session")
        override fun logout() { currentUser.value = null }
    }
    private class Endpoint(account: TestAccount, token: String, simulationUrl: String?, sessionId: String) {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        private val provider = object : AccessTokenProvider { override fun getAccessToken(): String = token }
        private val baseHttp = NetworkModule.provideOkHttpClient(AccessTokenInterceptor(provider), HttpLoggingInterceptor())
        val http = if (simulationUrl == null) baseHttp else baseHttp.newBuilder().addInterceptor { chain ->
            val request = chain.request()
            val url = simulationUrl.toHttpUrl().resolve(request.url.encodedPath.removePrefix("/kick/"))!!
            chain.proceed(request.newBuilder().url(url).header("x-fixture-hold-sse", "true").header("x-mock-session", sessionId).header("x-fixture-session", sessionId).build())
        }.build()
        private val json = NetworkModule.provideJson()
        private val retrofit = NetworkModule.provideRetrofit(json, http)
        private val streaming = NetworkModule.provideStreamingRetrofit(retrofit, NetworkModule.provideStreamingOkHttpClient(http))
        val accountClient = AccountClient(NetworkModule.provideAccountService(retrofit))
        val client = CallClient(NetworkModule.provideCallService(retrofit))
        val repo = CallRepositoryImpl(
            Auth(account), client,
            CallEventsClient(NetworkModule.provideCallEventService(streaming), json, Dispatchers.IO),
            scope, Dispatchers.IO,
        )
        suspend fun close() {
            repo.setForeground(false)
            scope.coroutineContext.job.cancelAndJoin()
            http.dispatcher.cancelAll()
            http.connectionPool.evictAll()
        }
    }

    @Test fun twoRepositoriesExchangeAcceptRejectCancelAndEndThroughLocalHttpAndSse() = runBlocking<Unit> {
        val url = System.getenv("KICK_SIMULATION_URL").orEmpty()
        assumeTrue("Local Postman simulation required", url.isNotBlank())
        exercise(url, "fixture-a", "fixture-b")
    }

    @Test fun dedicatedLiveAccountsExchangeSignalingWithoutJoiningMediaOrSynthesizingSpeech() = runBlocking<Unit> {
        assumeTrue(System.getenv("VOMI_RUN_CALL_LIVE_TESTS") == "1")
        val a = System.getenv("KICK_TEST_ACCOUNT_1_TOKEN").orEmpty()
        val b = System.getenv("KICK_TEST_ACCOUNT_2_TOKEN").orEmpty()
        require(a.isNotBlank() && b.isNotBlank()) { "Local test credentials required" }
        exercise(null, a, b)
    }

    private suspend fun exercise(simulationUrl: String?, tokenA: String, tokenB: String) {
        val fixtureSessionId = "signaling-" + UUID.randomUUID().toString()
        val a = Endpoint(TestAccount.User1, tokenA, simulationUrl, fixtureSessionId)
        val b = Endpoint(TestAccount.User2, tokenB, simulationUrl, fixtureSessionId)
        var ownedCallId: String? = null
        try {
            assertEquals("kick-test-1", a.accountClient.getCurrentAccount().id)
            assertEquals("kick-test-2", b.accountClient.getCurrentAccount().id)
            if (simulationUrl != null) {
                a.http.newCall(Request.Builder().url("https://3.37.162.168/kick/__fixture/reset")
                    .post(ByteArray(0).toRequestBody()).build()).execute().use { check(it.code == 204) }
            }
            // Never take over or terminate a pre-existing test call.
            assumeTrue("Dedicated accounts already have an active call", a.client.getActiveCall().call == null && b.client.getActiveCall().call == null)
            a.repo.setForeground(true); b.repo.setForeground(true)
            withTimeout(20_000) { a.repo.state.first { it.connection == CallConnection.Connected } }
            withTimeout(20_000) { b.repo.state.first { it.connection == CallConnection.Connected } }
            for (outcome in listOf("accept-end", "reject", "cancel")) {
                val created = a.repo.createCall("kick-test-2", UUID.randomUUID().toString()).single()
                ownedCallId = created.id
                val incoming = withTimeout(15_000) { b.repo.state.first { it.session?.id == created.id } }.session!!
                assertEquals("kick-test-2", incoming.calleeId)
                assertEquals(CallStatus.REQUESTED, incoming.status)
                when (outcome) {
                    "accept-end" -> {
                        b.repo.acceptCall(created.id).single()
                        withTimeout(15_000) { a.repo.state.first { it.session?.id == created.id && it.session?.status == CallStatus.ACCEPTED } }
                        assertEquals(CallStatus.ACCEPTED, b.repo.state.value.session!!.status)
                        a.repo.declineOrEndCall(created.id).single()
                        assertEquals("ENDED", a.client.getCall(created.id).status)
                    }
                    "reject" -> {
                        b.repo.declineOrEndCall(created.id).single()
                        assertEquals("REJECTED", a.client.getCall(created.id).status)
                    }
                    else -> {
                        a.repo.declineOrEndCall(created.id).single()
                        assertEquals("CANCELED", a.client.getCall(created.id).status)
                    }
                }
                withTimeout(15_000) { a.repo.state.first { it.session?.isTerminal != false } }
                withTimeout(15_000) { b.repo.state.first { it.session?.isTerminal != false } }
                ownedCallId = null
            }
        } finally {
            try {
                ownedCallId?.let { id ->
                    when (a.client.getCall(id).status) {
                        "REQUESTED" -> a.client.updateCall(id, CallAction.CANCEL)
                        "ACCEPTED" -> a.client.updateCall(id, CallAction.END)
                    }
                }
            } finally {
                // End fixture SSE responses before cancelling clients: CLI 1.76 can fail after a streamed proxy reset.
                try {
                    if (simulationUrl != null) a.http.newCall(Request.Builder().url("https://3.37.162.168/kick/__fixture/stop-events")
                        .post(ByteArray(0).toRequestBody()).build()).execute().use { check(it.code == 204) }
                } finally { a.close(); b.close() }
            }
        }
    }
}
