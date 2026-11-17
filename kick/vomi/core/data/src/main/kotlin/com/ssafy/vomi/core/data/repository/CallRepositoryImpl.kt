package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.common.network.Dispatcher
import com.ssafy.vomi.core.common.network.VomiDispatcher
import com.ssafy.vomi.core.data.call.CallSessionStore
import com.ssafy.vomi.core.data.mapper.toModel
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallSnapshot
import com.ssafy.vomi.core.network.model.call.CallAction
import com.ssafy.vomi.core.network.model.call.CreateCallRequest
import com.ssafy.vomi.core.network.service.call.CallClient
import com.ssafy.vomi.core.network.service.call.CallEvents
import java.io.IOException
import javax.inject.Inject
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.flow.update
import retrofit2.HttpException

internal class CallRepositoryImpl @Inject constructor(
    private val callClient: CallClient,
    private val callEvents: CallEvents,
    @param:Dispatcher(VomiDispatcher.IO) private val ioDispatcher: CoroutineDispatcher,
) : CallRepository {
    private val callSessionStore = CallSessionStore()
    override val callState = callSessionStore.state
    private val retryRequests = MutableStateFlow(0L)
    override val reconnectRequests: Flow<Unit> = retryRequests.map { Unit }

    override fun beginSession(userId: String) {
        require(userId.isNotBlank())
        callSessionStore.beginSession(userId)
    }

    override fun clearSession() = callSessionStore.clear()

    override fun retryConnection() {
        retryRequests.update { it + 1 }
    }

    override fun createCall(calleeId: String, requestId: String): Flow<CallSession> = flow {
        val userId = requireUserId()
        check(callSessionStore.tryStartCreating(userId)) { "A call cannot be created in the current state" }
        try {
            emitAll(
                flow {
                    val response = callClient.createCall(CreateCallRequest(calleeId, requestId))
                    emit(loadCall(response.id, userId))
                }.catch { error ->
                    refreshAfterFailure(userId)
                    throw error
                },
            )
        } finally {
            callSessionStore.finishCreating(userId)
        }
    }.flowOn(ioDispatcher)

    override fun getActiveCall(): Flow<CallSnapshot> = flow {
        emit(loadActiveCall(requireUserId()))
    }.flowOn(ioDispatcher)

    override fun getCall(callId: String): Flow<CallSession> = flow {
        emit(loadCall(callId, requireUserId()))
    }.flowOn(ioDispatcher)

    override fun observeCalls(): Flow<CallSnapshot> = flow {
        val userId = requireUserId()
        var failures = 0
        emitAll(
            flow {
                callSessionStore.setConnection(
                    userId,
                    if (failures == 0) CallConnection.Connecting else CallConnection.Reconnecting,
                )
                emit(loadActiveCall(userId))
                callEvents.events().collect { response ->
                    val snapshot = CallSnapshot(response.accountId, response.call?.toModel())
                    callSessionStore.applySnapshot(snapshot, userId)
                    callSessionStore.setConnection(userId, CallConnection.Connected)
                    failures = 0
                    emit(snapshot)
                }
                throw IOException("Call events disconnected")
            }.retryWhen { error, _ ->
                if (error is HttpException && (error.code() == 401 || error.code() == 403)) {
                    false
                } else {
                    callSessionStore.setConnection(userId, CallConnection.Reconnecting)
                    delay((1_000L shl failures.coerceAtMost(5)).coerceAtMost(30_000L).milliseconds)
                    failures = (failures + 1).coerceAtMost(5)
                    true
                }
            }.onCompletion { error ->
                callSessionStore.setConnection(
                    userId,
                    if (error is HttpException && error.code() == 403) CallConnection.Failed else CallConnection.Stopped,
                )
            },
        )
    }.flowOn(ioDispatcher)

    override fun acceptCall(callId: String) = changeCall(callId, CallAction.ACCEPT)
    override fun rejectCall(callId: String) = changeCall(callId, CallAction.REJECT)
    override fun cancelCall(callId: String) = changeCall(callId, CallAction.CANCEL)
    override fun endCall(callId: String) = changeCall(callId, CallAction.END)

    private fun changeCall(callId: String, action: CallAction): Flow<CallSession> = flow {
        val userId = requireUserId()
        emitAll(
            flow {
                callClient.updateCall(callId, action)
                emit(loadCall(callId, userId))
            }.catch { error ->
                refreshAfterFailure(userId)
                throw error
            },
        )
    }.flowOn(ioDispatcher)

    private suspend fun loadActiveCall(userId: String): CallSnapshot {
        val response = callClient.getActiveCall()
        val snapshot = CallSnapshot(response.accountId, response.call?.toModel())
        callSessionStore.applySnapshot(snapshot, userId)
        return snapshot
    }

    private suspend fun loadCall(callId: String, userId: String): CallSession {
        val session = callClient.getCall(callId).toModel()
        callSessionStore.applyCall(session, userId)
        return session
    }

    private suspend fun refreshAfterFailure(userId: String) {
        if (callState.value.accountId != userId) return
        flow { emit(loadActiveCall(userId)) }
            .catch { /* Preserve the original command error if recovery is unavailable. */ }
            .collect { }
    }

    private fun requireUserId(): String = checkNotNull(callState.value.accountId) {
        "A call session must be initialized before collecting call operations"
    }
}
