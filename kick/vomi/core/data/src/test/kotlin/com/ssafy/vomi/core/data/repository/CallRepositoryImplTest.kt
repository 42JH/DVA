package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.call.CallStatus
import com.ssafy.vomi.core.network.model.call.CallAction
import com.ssafy.vomi.core.network.model.call.CallResponse
import com.ssafy.vomi.core.network.model.call.CallStateResponse
import com.ssafy.vomi.core.network.model.call.CreateCallRequest
import com.ssafy.vomi.core.network.model.call.JoinCallResponse
import com.ssafy.vomi.core.network.model.call.UpdateCallRequest
import com.ssafy.vomi.core.network.service.call.CallClient
import com.ssafy.vomi.core.network.service.call.CallEvents
import com.ssafy.vomi.core.network.service.call.CallService
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.single
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CallRepositoryImplTest {
    private class Service : CallService {
        val requests = mutableListOf<CreateCallRequest>()
        val actions = mutableListOf<CallAction>()
        var call = CallResponse("call-1", "kick-test-1", "kick-test-2", "REQUESTED")
        var activeCall: CallResponse? = null
        var failure: Exception? = null
        override suspend fun createCall(request: CreateCallRequest): CallResponse {
            requests += request
            activeCall = call
            return call
        }
        override suspend fun getCall(callId: String): CallResponse { failure?.let { throw it }; return call }
        override suspend fun getActiveCall() = CallStateResponse("kick-test-1", activeCall)
        override suspend fun updateCall(callId: String, request: UpdateCallRequest) {
            actions += request.action
            call = call.copy(status = when (request.action) { CallAction.ACCEPT -> "ACCEPTED"; CallAction.REJECT -> "REJECTED"; CallAction.CANCEL -> "CANCELED"; CallAction.END -> "ENDED" })
        }
        override suspend fun joinCall(callId: String): JoinCallResponse = error("Unused")
    }
    private class Events(private val snapshot: CallStateResponse) : CallEvents {
        val subscribed = CompletableDeferred<Unit>()
        override fun events(): Flow<CallStateResponse> = flow {
            emit(snapshot)
            subscribed.complete(Unit)
            awaitCancellation()
        }
    }

    @Test fun creationIsColdAndKeepsTheCallersIdempotencyKey() = runTest {
        val service = Service()
        val events = Events(service.getActiveCall())
        val repo = CallRepositoryImpl(CallClient(service), events, StandardTestDispatcher(testScheduler))
        repo.beginSession("kick-test-1")
        val request = repo.createCall("kick-test-2", "stable-request")
        assertTrue(service.requests.isEmpty())
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { repo.observeCalls().collect { } }
        events.subscribed.await()
        val created = request.single()
        assertEquals(listOf("stable-request"), service.requests.map { it.requestId })
        assertEquals(created, repo.callState.value.session)
        assertFalse(repo.callState.value.isCreating)
    }

    @Test fun eachExplicitActionUsesItsWireActionAndReturnsFreshStatus() = runTest {
        val service = Service()
        val repo = CallRepositoryImpl(CallClient(service), Events(service.getActiveCall()), StandardTestDispatcher(testScheduler))
        repo.beginSession("kick-test-1")
        assertEquals(CallStatus.ACCEPTED, repo.acceptCall("call-1").single().status)
        assertEquals(CallStatus.ACCEPTED, repo.callState.value.session!!.status)
        assertEquals(CallStatus.REJECTED, repo.rejectCall("call-1").single().status)
        assertEquals(CallStatus.CANCELED, repo.cancelCall("call-1").single().status)
        assertEquals(CallStatus.ENDED, repo.endCall("call-1").single().status)
        assertEquals(CallAction.entries.toList(), service.actions)
    }

    @Test fun activeAndEventResponsesUpdateSharedStateOnlyWhenCollected() = runTest {
        val service = Service().apply { activeCall = call }
        val events = Events(service.getActiveCall().copy(call = service.call.copy(status = "ACCEPTED")))
        val repo = CallRepositoryImpl(CallClient(service), events, StandardTestDispatcher(testScheduler))
        repo.beginSession("kick-test-1")
        assertNull(repo.callState.value.session)
        assertEquals("kick-test-1", repo.getActiveCall().single().accountId)
        assertEquals("call-1", repo.observeCalls().drop(1).first().session!!.id)
        assertEquals(CallStatus.ACCEPTED, repo.callState.value.session!!.status)
    }

    @Test fun errorsRemainFailuresForTheConsumer() = runTest {
        val service = Service().apply { failure = IOException("offline") }
        val repo = CallRepositoryImpl(CallClient(service), Events(service.getActiveCall()), StandardTestDispatcher(testScheduler))
        repo.beginSession("kick-test-1")
        try { repo.getCall("call-1").single(); fail() } catch (_: IOException) { }
    }
}
