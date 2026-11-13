package com.ssafy.vomi.core.network.service.call

import com.ssafy.vomi.core.network.model.call.CallAction
import com.ssafy.vomi.core.network.model.call.CallResponse
import com.ssafy.vomi.core.network.model.call.CallStateResponse
import com.ssafy.vomi.core.network.model.call.CreateCallRequest
import com.ssafy.vomi.core.network.model.call.JoinCallResponse
import com.ssafy.vomi.core.network.model.call.UpdateCallRequest
import javax.inject.Inject

class CallClient @Inject constructor(private val callService: CallService) {
    /** Keep this request's requestId when retrying the same outgoing call. */
    suspend fun createCall(request: CreateCallRequest): CallResponse = callService.createCall(request)

    suspend fun getActiveCall(): CallStateResponse = callService.getActiveCall()

    suspend fun getCall(callId: String): CallResponse = callService.getCall(callId)

    suspend fun updateCall(callId: String, action: CallAction) =
        callService.updateCall(callId, UpdateCallRequest(action))

    suspend fun joinCall(callId: String): JoinCallResponse = callService.joinCall(callId)
}
