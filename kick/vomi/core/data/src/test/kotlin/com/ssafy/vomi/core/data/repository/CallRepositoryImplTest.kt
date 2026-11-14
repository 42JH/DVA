package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.model.auth.UserSession
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.CallStatus
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
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.single
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

@OptIn(ExperimentalCoroutinesApi::class)
class CallRepositoryImplTest {
    private class Auth : AuthRepository {
        override val currentUser = MutableStateFlow<UserSession?>(UserSession("kick-test-1", "사용자1", TestAccount.User1))
        override fun login(account: TestAccount): Flow<UserSession> = error("Unused")
        override fun logout() { currentUser.value = null }
    }
    private class Events : CallEvents {
        val bus = MutableSharedFlow<CallStateResponse>(replay = 1)
        var opens = 0
        var active = 0
        override fun events(): Flow<CallStateResponse> = flow {
            opens++; active++
            try { bus.collect { emit(it) } } finally { active-- }
        }
    }
    private class Service(val auth: Auth) : CallService {
        val calls = mutableMapOf<String, CallResponse>()
        val requests = mutableListOf<CreateCallRequest>()
        val actions = mutableListOf<UpdateCallRequest>()
        var activeId: String? = null
        var postGate: CompletableDeferred<Unit>? = null
        var getGate: CompletableDeferred<Unit>? = null
        var postFailure: Exception? = null
        var patchFailure: Exception? = null
        var activeFailure: Exception? = null
        override suspend fun createCall(request: CreateCallRequest): CallResponse {
            requests += request
            val call = calls.getOrPut(request.requestId) {
                CallResponse(request.requestId, "kick-test-1", request.calleeId, "REQUESTED")
            }
            activeId = call.id
            postGate?.await()
            postFailure?.let { throw it }
            return call
        }
        override suspend fun getActiveCall(): CallStateResponse {
            activeFailure?.let { throw it }
            return CallStateResponse(auth.currentUser.value!!.id, activeId?.let { calls[it] })
        }
        override suspend fun getCall(callId: String): CallResponse {
            val response = calls.getValue(callId)
            getGate?.await()
            return response
        }
        override suspend fun updateCall(callId: String, request: UpdateCallRequest) {
            actions += request
            patchFailure?.let { throw it }
            val status = when (request.action.name) { "ACCEPT" -> "ACCEPTED"; "REJECT" -> "REJECTED"; "CANCEL" -> "CANCELED"; else -> "ENDED" }
            calls[callId] = calls.getValue(callId).copy(status = status)
            if (status != "ACCEPTED") activeId = null
        }
        override suspend fun joinCall(callId: String): JoinCallResponse = error("Media is outside this task")
    }
    private class Fixture(scope: TestScope) {
        val auth = Auth()
        val events = Events().apply { bus.tryEmit(CallStateResponse("kick-test-1", null)) }
        val service = Service(auth)
        val repo = CallRepositoryImpl(auth, CallClient(service), events, scope.backgroundScope, StandardTestDispatcher(scope.testScheduler))
        fun outgoing(): CallResponse = CallResponse("call-1", "kick-test-1", "kick-test-2", "REQUESTED").also {
            service.calls[it.id] = it; service.activeId = it.id
            events.bus.tryEmit(CallStateResponse(auth.currentUser.value!!.id, it))
        }
    }

    @Test fun foregroundOwnsOneSubscriptionAndLogoutClearsCallAndStopsEvents() = runTest {
        val f = Fixture(this)
        runCurrent()
        assertEquals(0, f.events.opens)
        f.repo.setForeground(true); f.repo.setForeground(true); runCurrent()
        assertEquals(1, f.events.opens)
        assertEquals(CallConnection.Connected, f.repo.state.value.connection)
        f.outgoing(); runCurrent()
        assertEquals("call-1", f.repo.state.value.session!!.id)
        f.repo.setForeground(false); runCurrent()
        assertEquals(0, f.events.active)
        f.repo.setForeground(true); runCurrent()
        assertEquals(2, f.events.opens)
        f.auth.logout(); runCurrent()
        assertNull(f.repo.state.value.session)
        assertNull(f.repo.state.value.accountId)
        assertEquals(0, f.events.active)
    }

    @Test fun sameRequestIdRecoversAWriteWhoseResponseWasLost() = runTest {
        val f = Fixture(this); f.repo.setForeground(true); runCurrent()
        f.service.postFailure = IOException("lost response")
        try { f.repo.createCall("kick-test-2", "stable-id").single(); fail() } catch (_: IOException) { }
        f.service.postFailure = null
        val call = f.repo.createCall("kick-test-2", "stable-id").single()
        assertEquals("stable-id", call.id)
        assertEquals(1, f.service.calls.size)
        assertEquals(listOf("stable-id", "stable-id"), f.service.requests.map { it.requestId })
        assertFalse(f.repo.state.value.isCreating)
    }

    @Test fun outgoingCancelUsesCancelAndTerminalCallCannotBeAccepted() = runTest {
        val f = Fixture(this); f.repo.setForeground(true); runCurrent(); f.outgoing(); runCurrent()
        f.repo.declineOrEndCall("call-1").single()
        assertEquals("CANCEL", f.service.actions.single().action.name)
        assertEquals(CallStatus.CANCELED, f.repo.state.value.session!!.status)
        try { f.repo.acceptCall("call-1").single(); fail() } catch (_: IllegalStateException) { }
        assertEquals(1, f.service.actions.size)
    }

    @Test fun receiverAcceptsThenEitherSideCanEndAnAcceptedCall() = runTest {
        val f = Fixture(this)
        f.auth.currentUser.value = UserSession("kick-test-2", "사용자2", TestAccount.User2)
        f.outgoing(); f.repo.setForeground(true); runCurrent()
        f.repo.acceptCall("call-1").single()
        assertEquals(CallStatus.ACCEPTED, f.repo.state.value.session!!.status)
        f.repo.declineOrEndCall("call-1").single()
        assertEquals(listOf("ACCEPT", "END"), f.service.actions.map { it.action.name })
    }

    @Test fun receiverDeclinesWithRejectAndCallerCannotAcceptItsOwnRequest() = runTest {
        val f = Fixture(this); f.repo.setForeground(true); runCurrent(); f.outgoing(); runCurrent()
        try { f.repo.acceptCall("call-1").single(); fail() } catch (_: IllegalStateException) { }
        assertTrue(f.service.actions.isEmpty())
        f.auth.currentUser.value = UserSession("kick-test-2", "사용자2", TestAccount.User2)
        f.events.bus.tryEmit(CallStateResponse("kick-test-2", f.service.calls["call-1"]))
        runCurrent()
        f.repo.declineOrEndCall("call-1").single()
        assertEquals("REJECT", f.service.actions.single().action.name)
    }

    @Test fun eventAcceptanceCannotBeRegressedByDelayedRequestedHttpResponse() = runTest {
        val f = Fixture(this); f.repo.setForeground(true); runCurrent()
        f.service.getGate = CompletableDeferred()
        val pending = async { f.repo.createCall("kick-test-2", "race-id").single() }
        runCurrent()
        f.events.bus.emit(CallStateResponse("kick-test-1", f.service.calls.getValue("race-id").copy(status = "ACCEPTED")))
        runCurrent()
        f.service.getGate!!.complete(Unit); pending.await()
        assertEquals(CallStatus.ACCEPTED, f.repo.state.value.session!!.status)
    }

    @Test fun nullSnapshotPreventsDelayedHttpResponseFromRevivingEndedCall() = runTest {
        val f = Fixture(this); f.repo.setForeground(true); runCurrent()
        f.service.getGate = CompletableDeferred()
        val pending = async { f.repo.createCall("kick-test-2", "race-id").single() }
        runCurrent()
        f.events.bus.emit(CallStateResponse("kick-test-1", f.service.calls.getValue("race-id"))); runCurrent()
        f.events.bus.emit(CallStateResponse("kick-test-1", null)); runCurrent()
        f.service.getGate!!.complete(Unit); pending.await()
        assertNull(f.repo.state.value.session)
    }

    @Test fun logoutDuringRequestDoesNotRepopulateThePreviousAccountState() = runTest {
        val f = Fixture(this); f.repo.setForeground(true); runCurrent()
        f.service.postGate = CompletableDeferred()
        val pending = async { runCatching { f.repo.createCall("kick-test-2", "late-id").single() } }
        runCurrent(); f.auth.logout(); runCurrent()
        f.service.postGate!!.complete(Unit)
        assertTrue(pending.await().isFailure)
        assertNull(f.repo.state.value.accountId)
        assertNull(f.repo.state.value.session)
    }

    @Test fun requestInFlightRejectsAnotherCreateInsteadOfQueueingIt() = runTest {
        val f = Fixture(this); f.repo.setForeground(true); runCurrent()
        f.service.postGate = CompletableDeferred()
        val pending = async { f.repo.createCall("kick-test-2", "first").single() }
        runCurrent()
        try { f.repo.createCall("kick-test-2", "second").single(); fail() } catch (_: IllegalStateException) { }
        f.service.postGate!!.complete(Unit); pending.await()
        assertEquals(1, f.service.requests.size)
    }

    @Test fun mismatchedAccountEventIsIgnoredAndReconnectRefreshesAuthoritativeState() = runTest {
        val f = Fixture(this); f.repo.setForeground(true); runCurrent()
        f.events.bus.emit(CallStateResponse("other-account", null)); runCurrent()
        assertEquals(CallConnection.Reconnecting, f.repo.state.value.connection)
        f.outgoing()
        advanceTimeBy(1_000); runCurrent()
        assertEquals("call-1", f.repo.state.value.session!!.id)
        assertEquals(CallConnection.Connected, f.repo.state.value.connection)
    }

    @Test fun unauthorizedMonitorStopsRetriesUntilExplicitRetry() = runTest {
        val f = Fixture(this)
        f.service.activeFailure = HttpException(Response.error<Unit>(401, "".toResponseBody()))
        f.repo.setForeground(true); runCurrent()
        assertEquals(CallConnection.Failed, f.repo.state.value.connection)
        advanceTimeBy(60_000); runCurrent()
        assertEquals(0, f.events.opens)
        f.service.activeFailure = null
        f.repo.retryConnection(); runCurrent()
        assertEquals(CallConnection.Connected, f.repo.state.value.connection)
    }

    @Test fun failedAcceptReconcilesRemoteCancellationWithoutPretendingSuccess() = runTest {
        val f = Fixture(this)
        f.auth.currentUser.value = UserSession("kick-test-2", "사용자2", TestAccount.User2)
        f.outgoing(); f.repo.setForeground(true); runCurrent()
        f.service.patchFailure = HttpException(Response.error<Unit>(409, "".toResponseBody()))
        f.service.activeId = null
        try { f.repo.acceptCall("call-1").single(); fail() } catch (error: HttpException) { assertEquals(409, error.code()) }
        assertNull(f.repo.state.value.session)
    }
}
