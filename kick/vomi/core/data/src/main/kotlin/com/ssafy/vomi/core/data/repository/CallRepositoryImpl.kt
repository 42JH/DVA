package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.common.network.Dispatcher
import com.ssafy.vomi.core.common.network.VomiDispatcher
import com.ssafy.vomi.core.common.network.di.ApplicationScope
import com.ssafy.vomi.core.data.mapper.toModel
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallSignalingState
import com.ssafy.vomi.core.model.call.CallStatus
import com.ssafy.vomi.core.network.model.call.CallAction
import com.ssafy.vomi.core.network.model.call.CallStateResponse
import com.ssafy.vomi.core.network.model.call.CreateCallRequest
import com.ssafy.vomi.core.network.service.call.CallClient
import com.ssafy.vomi.core.network.service.call.CallEvents
import java.io.IOException
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import retrofit2.HttpException

internal class CallRepositoryImpl @Inject constructor(
    private val auth: AuthRepository,
    private val client: CallClient,
    private val events: CallEvents,
    @ApplicationScope scope: CoroutineScope,
    @param:Dispatcher(VomiDispatcher.IO) private val io: CoroutineDispatcher,
) : CallRepository {
    private val mutableState = MutableStateFlow(CallSignalingState())
    override val state = mutableState.asStateFlow()
    private val foreground = MutableStateFlow(false)
    private val retry = MutableStateFlow(0L)
    private val generation = AtomicLong()
    private val stateMutex = Mutex()
    private val commandMutex = Mutex()
    private val finishedIds = mutableSetOf<String>()

    init {
        scope.launch(io) {
            auth.currentUser.map { it?.id }.distinctUntilChanged().collectLatest { accountId ->
                val version = generation.incrementAndGet()
                stateMutex.withLock {
                    finishedIds.clear()
                    mutableState.value = CallSignalingState(accountId = accountId)
                }
                if (accountId != null) {
                    combine(foreground, retry) { visible, _ -> visible }.collectLatest { visible ->
                        if (visible) monitor(accountId, version)
                        else mutableState.update { it.copy(connection = CallConnection.Stopped) }
                    }
                }
            }
        }
    }

    override fun setForeground(foreground: Boolean) { this.foreground.value = foreground }
    override fun retryConnection() { retry.update { it + 1 } }

    private fun matches(accountId: String, version: Long): Boolean =
        generation.get() == version && auth.currentUser.value?.id == accountId

    private suspend fun monitor(accountId: String, version: Long) {
        var failures = 0
        try {
            while (currentCoroutineContext().isActive && matches(accountId, version)) {
                mutableState.update { it.copy(connection = if (failures == 0) CallConnection.Connecting else CallConnection.Reconnecting) }
                try {
                    applySnapshot(client.getActiveCall(), accountId, version)
                    events.events().collect { snapshot ->
                        applySnapshot(snapshot, accountId, version)
                        if (matches(accountId, version)) mutableState.update { it.copy(connection = CallConnection.Connected) }
                        failures = 0
                    }
                    throw IOException("Call events disconnected")
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (!matches(accountId, version)) return
                    if (error is HttpException && error.code() in listOf(401, 403)) {
                        mutableState.update { it.copy(connection = CallConnection.Failed) }
                        return
                    }
                    mutableState.update { it.copy(connection = CallConnection.Reconnecting) }
                    delay((1_000L shl failures.coerceAtMost(5)).coerceAtMost(30_000L))
                    failures++
                }
            }
        } finally {
            if (matches(accountId, version) && state.value.connection != CallConnection.Failed) mutableState.update { it.copy(connection = CallConnection.Stopped) }
        }
    }

    private suspend fun applySnapshot(snapshot: CallStateResponse, accountId: String, version: Long) {
        if (snapshot.accountId != accountId) throw IOException("Call event account mismatch")
        val session = snapshot.call?.toModel()
        if (session != null && session.callerId != accountId && session.calleeId != accountId) {
            throw IOException("Call participant mismatch")
        }
        stateMutex.withLock {
            if (!matches(accountId, version)) return
            val previous = mutableState.value.session
            if (session == null) {
                previous?.let { finishedIds += it.id }
                mutableState.update { it.copy(session = null) }
            } else {
                if (previous != null && previous.id != session.id) finishedIds += previous.id
                mergeSession(session)
            }
        }
    }

    // Server transitions are monotonic per call; a delayed HTTP response must not revive an ended call.
    private fun mergeSession(session: CallSession) {
        if (session.id in finishedIds && !session.isTerminal) return
        val previous = mutableState.value.session
        if (previous?.id == session.id &&
            (previous.isTerminal || previous.status == CallStatus.ACCEPTED && session.status == CallStatus.REQUESTED)) return
        if (session.isTerminal) finishedIds += session.id
        mutableState.update { it.copy(session = session) }
    }

    private suspend fun applySession(session: CallSession, accountId: String, version: Long) {
        require(session.callerId == accountId || session.calleeId == accountId)
        stateMutex.withLock {
            val current = state.value.session
            if (matches(accountId, version) && (current == null || current.id == session.id || current.isTerminal)) mergeSession(session)
        }
    }

    override fun createCall(calleeId: String, requestId: String): Flow<CallSession> = flow {
        check(commandMutex.tryLock()) { "A call request is already running" }
        val accountId = auth.currentUser.value?.id
        val version = generation.get()
        try {
            check(accountId != null && state.value.accountId == accountId && state.value.canStartCall) { "Call connection is not ready" }
            require(calleeId != accountId && requestId.isNotBlank())
            mutableState.update { it.copy(isCreating = true) }
            val response = client.createCall(CreateCallRequest(calleeId, requestId)).toModel()
            currentCoroutineContext().ensureActive()
            check(matches(accountId, version)) { "Account changed" }
            // Reconcile with the server because an SSE acceptance/end may precede the POST response.
            val latest = client.getCall(response.id).toModel()
            check(matches(accountId, version)) { "Account changed" }
            applySession(latest, accountId, version)
            emit(latest)
        } finally {
            if (accountId != null && matches(accountId, version)) mutableState.update { it.copy(isCreating = false) }
            commandMutex.unlock()
        }
    }.flowOn(io)

    override fun acceptCall(callId: String): Flow<Unit> = changeCall(callId, accept = true)
    override fun declineOrEndCall(callId: String): Flow<Unit> = changeCall(callId, accept = false)

    private fun changeCall(callId: String, accept: Boolean): Flow<Unit> = flow {
        check(commandMutex.tryLock()) { "A call action is already running" }
        val accountId = auth.currentUser.value?.id
        val version = generation.get()
        try {
            check(accountId != null && state.value.accountId == accountId) { "No authenticated call" }
            val session = state.value.session
            check(session != null && session.id == callId && !session.isTerminal) { "Call is no longer active" }
            val action = when {
                accept -> { check(session.calleeId == accountId && session.status == CallStatus.REQUESTED); CallAction.ACCEPT }
                session.status == CallStatus.ACCEPTED -> CallAction.END
                session.callerId == accountId -> CallAction.CANCEL
                else -> CallAction.REJECT
            }
            try {
                client.updateCall(callId, action)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                // A 409 or network failure may race a remote cancel/accept. Refresh without forcing local success.
                try { applySnapshot(client.getActiveCall(), accountId, version) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { }
                throw error
            }
            val latest = client.getCall(callId).toModel()
            check(matches(accountId, version)) { "Account changed" }
            applySession(latest, accountId, version)
            emit(Unit)
        } finally { commandMutex.unlock() }
    }.flowOn(io)
}
