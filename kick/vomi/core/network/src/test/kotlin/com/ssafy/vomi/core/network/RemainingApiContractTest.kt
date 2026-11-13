package com.ssafy.vomi.core.network

import com.ssafy.vomi.core.network.auth.AccessTokenInterceptor
import com.ssafy.vomi.core.network.auth.AccessTokenProvider
import com.ssafy.vomi.core.network.di.NetworkModule
import com.ssafy.vomi.core.network.model.account.CreateAccountRequest
import com.ssafy.vomi.core.network.model.call.CallAction
import com.ssafy.vomi.core.network.model.call.CreateCallRequest
import com.ssafy.vomi.core.network.service.account.AccountClient
import com.ssafy.vomi.core.network.service.call.CallClient
import com.ssafy.vomi.core.network.service.call.CallEventsClient
import com.ssafy.vomi.core.network.service.device.DeviceClient
import com.ssafy.vomi.core.network.service.friend.FriendClient
import com.ssafy.vomi.core.network.service.health.HealthClient
import com.ssafy.vomi.core.network.service.voice.VoiceClient
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import okio.Buffer
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import retrofit2.HttpException

/** Actual Retrofit/OkHttp HTTP requests to the opt-in local Postman contract simulation. */
class RemainingApiContractTest {
    private class Tokens(var value: String = "fixture-a") : AccessTokenProvider {
        override fun getAccessToken(): String = value
    }
    private data class Captured(val request: Request, val body: String)
    private val tokens = Tokens()
    private val captured = mutableListOf<Captured>()
    private lateinit var http: OkHttpClient
    private lateinit var streamingHttp: OkHttpClient
    private lateinit var account: AccountClient
    private lateinit var friends: FriendClient
    private lateinit var calls: CallClient
    private lateinit var voice: VoiceClient
    private lateinit var devices: DeviceClient
    private lateinit var health: HealthClient
    private lateinit var events: CallEventsClient

    @Before fun configure() {
        val simulationUrl = System.getenv("KICK_SIMULATION_URL").orEmpty()
        assumeTrue("Run the local contract simulation to enable HTTP integration tests", simulationUrl.isNotBlank())
        val destination = simulationUrl.toHttpUrl()
        val baseHttp = NetworkModule.provideOkHttpClient(AccessTokenInterceptor(tokens), HttpLoggingInterceptor())
        // Auth and Retrofit keep their production URL; only the final transport destination changes for the test.
        http = baseHttp.newBuilder().addInterceptor { chain ->
            val request = chain.request()
            val buffer = Buffer()
            request.body?.writeTo(buffer)
            synchronized(captured) { captured += Captured(request, buffer.readUtf8()) }
            val url = destination.resolve(request.url.encodedPath.removePrefix("/kick/"))!!
                .newBuilder().encodedQuery(request.url.encodedQuery).build()
            chain.proceed(request.newBuilder().url(url).build())
        }.build()
        streamingHttp = NetworkModule.provideStreamingOkHttpClient(http)
        val json = NetworkModule.provideJson()
        val retrofit = NetworkModule.provideRetrofit(json, http)
        val streamingRetrofit = NetworkModule.provideStreamingRetrofit(retrofit, streamingHttp)
        account = AccountClient(NetworkModule.provideAccountService(retrofit))
        friends = FriendClient(NetworkModule.provideFriendService(retrofit))
        calls = CallClient(NetworkModule.provideCallService(retrofit))
        voice = VoiceClient(NetworkModule.provideVoiceService(retrofit), NetworkModule.provideVoiceSpeechService(streamingRetrofit))
        devices = DeviceClient(NetworkModule.provideDeviceService(retrofit))
        health = HealthClient(NetworkModule.provideHealthService(retrofit))
        events = CallEventsClient(NetworkModule.provideCallEventService(streamingRetrofit), json, Dispatchers.IO)
        http.newCall(Request.Builder().url(NetworkConfig.BASE_URL + "__fixture/reset")
            .post(ByteArray(0).toRequestBody()).build()).execute().use { check(it.code == 204) }
        captured.clear()
    }

    @Test fun publicSignupAndHealthDoNotSendExistingSessionCredentials() = runBlocking {
        assertEquals("ok", health.getHealth().status)
        val created = account.createAccount(CreateAccountRequest("새 사용자", "fixture-invite"))
        assertEquals("fixture-created", created.id)
        assertEquals("새 사용자", created.displayName)
        assertEquals("fixture-created-token", created.token)
        assertFalse(created.toString().contains(created.token))
        assertTrue(captured.all { it.request.header("Authorization") == null })
        assertEquals("fixture-a", tokens.value)
        expectStatus(403) { account.createAccount(CreateAccountRequest("새 사용자", "wrong-code")) }
    }

    @Test fun friendAdditionUsesBodylessPutAndEncodedPath() = runBlocking {
        assertEquals("kick-test-2", friends.getFriends().single().id)
        assertEquals("친구 id", friends.addFriend("친구 id").id)
        assertTrue(friends.getFriends().any { it.id == "친구 id" })
        val put = captured.first { it.request.method == "PUT" }
        assertEquals("", put.body)
        assertTrue(put.request.url.encodedPath.contains("%20"))
        assertTrue(captured.all { it.request.header("Authorization") == "Bearer fixture-a" })
    }

    @Test fun voiceRegistrationEncodesFileAndExplicitConsentAsMultipartParts() = runBlocking {
        assertEquals("READY", voice.getVoice().status)
        val audio = File.createTempFile("fixture-voice", ".wav").apply { writeBytes(byteArrayOf(82, 73, 70, 70)) }
        try {
            assertEquals("CREATING", voice.registerVoice(audio, consent = true).status)
            val upload = captured.last()
            assertEquals("POST", upload.request.method)
            assertTrue(upload.request.body!!.contentType().toString().startsWith("multipart/form-data;"))
            assertTrue(upload.body.contains("name=\"audio\"; filename=\"" + audio.name + "\""))
            assertTrue(upload.body.contains("Content-Type: audio/wav"))
            assertTrue(upload.body.contains("name=\"consent\""))
            assertTrue(upload.body.contains("\r\n\r\ntrue\r\n"))
            assertEquals("CREATING", voice.getVoice().status)
        } finally { audio.delete() }
    }

    @Test fun createAcceptJoinAndEndPreserveRequestIdAndNullableActiveState() = runBlocking {
        assertNull(calls.getActiveCall().call)
        val request = CreateCallRequest("kick-test-2", UUID.randomUUID().toString())
        val call = calls.createCall(request)
        assertEquals("REQUESTED", call.status)
        assertEquals(call.id, calls.createCall(request).id)
        assertEquals(call.id, calls.getActiveCall().call!!.id)
        expectStatus(409) { calls.joinCall(call.id) }
        calls.updateCall(call.id, CallAction.ACCEPT)
        assertEquals("ACCEPTED", calls.getCall(call.id).status)
        val join = calls.joinCall(call.id)
        assertTrue(join.url.startsWith("wss://"))
        assertEquals("fixture-join-token", join.token)
        assertFalse(join.toString().contains(join.token))
        calls.updateCall(call.id, CallAction.END)
        assertEquals("ENDED", calls.getCall(call.id).status)
        assertNull(calls.getActiveCall().call)
        val creates = captured.filter { it.request.method == "POST" && it.request.url.encodedPath == "/kick/api/calls" }
        assertEquals(creates[0].body, creates[1].body)
    }

    @Test fun rejectAndCancelUseLowercaseWireActionsAndAcceptEmptySuccessBodies() = runBlocking {
        for ((action, expected) in listOf(CallAction.REJECT to "REJECTED", CallAction.CANCEL to "CANCELED")) {
            val call = calls.createCall(CreateCallRequest("kick-test-2", UUID.randomUUID().toString()))
            calls.updateCall(call.id, action)
            val patch = captured.last()
            assertEquals(action.name.lowercase(), Json.parseToJsonElement(patch.body).jsonObject.getValue("action").jsonPrimitive.content)
            assertEquals(expected, calls.getCall(call.id).status)
        }
    }

    @Test fun pushTokenDeleteKeepsItsJsonBodyAndBoth204ResponsesAreSupported() = runBlocking {
        devices.registerPushToken("fixture-device")
        devices.unregisterPushToken("fixture-device")
        assertEquals(listOf("PUT", "DELETE"), captured.map { it.request.method })
        for (entry in captured) {
            assertEquals("/kick/api/devices/push", entry.request.url.encodedPath)
            assertEquals("fixture-device", Json.parseToJsonElement(entry.body).jsonObject.getValue("token").jsonPrimitive.content)
        }
    }

    @Test fun speechStaysRawPcmAndDoesNotTruncateOrRewriteEnteredText() = runBlocking {
        val text = "지금 잘 들려?"
        voice.streamSpeech(text).use {
            assertEquals("audio/pcm", it.contentType().toString())
            assertArrayEquals(byteArrayOf(0, 0, 1, 0, 2, 0), it.bytes())
        }
        assertEquals(text, Json.parseToJsonElement(captured.last().body).jsonObject.getValue("text").jsonPrimitive.content)
        expectStatus(400) { voice.streamSpeech("가".repeat(51)).close() }
        assertEquals(30_000, http.callTimeoutMillis)
        assertEquals(0, streamingHttp.callTimeoutMillis)
        assertEquals(0, streamingHttp.readTimeoutMillis)
    }

    @Test fun eventsDecodeBothInactiveAndActiveSnapshotsAndCanBeCollectedAgain() = runBlocking {
        val initial = withTimeout(5_000) { events.events().first() }
        assertEquals("kick-test-1", initial.accountId)
        assertNull(initial.call)
        val call = calls.createCall(CreateCallRequest("kick-test-2", UUID.randomUUID().toString()))
        val active = withTimeout(5_000) { events.events().first() }
        assertEquals(call.id, active.call!!.id)
        assertTrue(captured.filter { it.request.url.encodedPath.endsWith("/events") }
            .all { it.request.header("Accept") == "text/event-stream" })
    }

    @Test fun httpErrorsRemainFailuresIncludingSseAndHtmlGatewayResponses() = runBlocking {
        expectStatus(404) { calls.getCall("missing-call") }
        tokens.value = "invalid-fixture"
        expectStatus(401) { friends.getFriends() }
        expectStatus(401) { withTimeout(5_000) { events.events().first() } }
        tokens.value = "fixture-a"
        val retrofit = NetworkModule.provideRetrofit(NetworkModule.provideJson(), http).newBuilder()
            .baseUrl(NetworkConfig.BASE_URL + "unavailable/").build()
        expectStatus(503) { FriendClient(NetworkModule.provideFriendService(retrofit)).getFriends() }
    }

    private suspend fun expectStatus(status: Int, block: suspend () -> Unit) {
        try { block(); fail("Expected HTTP $status") }
        catch (error: HttpException) { assertEquals(status, error.code()) }
    }
}
