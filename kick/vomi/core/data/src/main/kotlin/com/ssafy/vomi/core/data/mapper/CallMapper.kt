package com.ssafy.vomi.core.data.mapper

import com.ssafy.vomi.core.model.call.CallSession
import com.ssafy.vomi.core.model.call.CallStatus
import com.ssafy.vomi.core.network.model.call.CallResponse
import java.io.IOException

internal fun CallResponse.toModel(): CallSession = CallSession(
    id = id,
    callerId = callerId,
    calleeId = calleeId,
    status = CallStatus.entries.find { it.name == status } ?: throw IOException("Unsupported call status"),
)
