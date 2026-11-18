package com.ssafy.vomi.core.network.service.call

import com.ssafy.vomi.core.network.auth.AccessTokenInterceptor
import com.ssafy.vomi.core.network.auth.AccessTokenProvider
import com.ssafy.vomi.core.network.di.NetworkModule
import com.ssafy.vomi.core.network.model.call.CallStateResponse
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.SerializationException
import okhttp3.logging.HttpLoggingInterceptor
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class CallEventsClientTest {
    private val json = NetworkModule.provideJson()

    @Test fun parserAcceptsBomCommentsCrLfMultilineDataAndOptionalSpaces() = runBlocking {
        val input = "\uFEFF: heartbeat\r\nevent: call\r\ndata: {\r\ndata: \"accountId\": \"kick-test-1\",\r\ndata:\"call\": null}\r\n\r\n"
        val values = mutableListOf<CallStateResponse>()
        readCallEvents(Buffer().writeUtf8(input), json) { values += it }
        assertEquals("kick-test-1", values.single().accountId)
        assertNull(values.single().call)
    }

    @Test fun parserIgnoresOtherEventTypesAndIncompleteTrailingEvent() = runBlocking {
        val input = "event: ping\ndata: not-json\n\nevent: call\ndata: {\"accountId\":\"kick-test-1\",\"call\":null}"
        val values = mutableListOf<CallStateResponse>()
        readCallEvents(Buffer().writeUtf8(input), json) { values += it }
        assertTrue(values.isEmpty())
    }

    @Test fun malformedCallDataFailsInsteadOfBecomingAnInactiveCall() = runBlocking {
        try {
            readCallEvents(Buffer().writeUtf8("event: call\ndata: not-json\n\n"), json) { fail("Should not emit") }
            fail("Expected malformed JSON failure")
        } catch (_: SerializationException) { }
    }

    @Test fun cancellingCollectionClosesTheActualStreamingHttpSocket() = runBlocking<Unit> {
        val closed = CountDownLatch(1)
        val serverFailure = AtomicReference<Throwable?>()
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val worker = Thread {
            try {
                server.accept().use { socket ->
                    socket.soTimeout = 5_000
                    val input = socket.getInputStream().bufferedReader()
                    while (!input.readLine().isNullOrEmpty()) { }
                    val output = socket.getOutputStream()
                    output.write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n" +
                        "event: call\ndata: {\"accountId\":\"kick-test-1\",\"call\":null}\n\n").toByteArray())
                    output.flush()
                    if (input.read() == -1) closed.countDown()
                }
            } catch (error: Throwable) { serverFailure.set(error) }
        }.apply { isDaemon = true; start() }
        val provider = object : AccessTokenProvider { override fun getAccessToken(): String? = null }
        val http = NetworkModule.provideStreamingOkHttpClient(
            NetworkModule.provideOkHttpClient(AccessTokenInterceptor(provider), HttpLoggingInterceptor()),
        )
        try {
            val retrofit = NetworkModule.provideRetrofit(json, http).newBuilder()
                .baseUrl("http://127.0.0.1:" + server.localPort + "/kick/").build()
            val client = CallEventsClient(NetworkModule.provideCallEventService(retrofit), json, Dispatchers.IO)
            assertEquals("kick-test-1", withTimeout(5_000) { client.events().first() }.accountId)
            assertTrue("Cancelling the flow must close the streaming connection", closed.await(5, TimeUnit.SECONDS))
            serverFailure.get()?.let { throw AssertionError("Fixture failed", it) }
        } finally {
            server.close()
            http.dispatcher.cancelAll()
            http.connectionPool.evictAll()
            worker.join(1_000)
        }
    }
}
