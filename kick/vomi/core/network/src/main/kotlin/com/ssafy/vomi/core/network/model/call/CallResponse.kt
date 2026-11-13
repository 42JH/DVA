package com.ssafy.vomi.core.network.model.call

import kotlinx.serialization.Serializable

@Serializable
data class CallResponse(
    val id: String,
    val callerId: String,
    val calleeId: String,
    val status: String,
    val requestedAt: String? = null,
)
