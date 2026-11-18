package com.ssafy.vomi.core.network.model.call

import kotlinx.serialization.Serializable

@Serializable
data class CreateCallRequest(val calleeId: String, val requestId: String)
