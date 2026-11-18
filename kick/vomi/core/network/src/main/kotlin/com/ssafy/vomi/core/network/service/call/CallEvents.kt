package com.ssafy.vomi.core.network.service.call

import com.ssafy.vomi.core.network.model.call.CallStateResponse
import kotlinx.coroutines.flow.Flow

interface CallEvents {
    fun events(): Flow<CallStateResponse>
}
