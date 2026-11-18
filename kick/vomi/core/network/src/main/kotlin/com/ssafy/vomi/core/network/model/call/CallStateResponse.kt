package com.ssafy.vomi.core.network.model.call

import kotlinx.serialization.Serializable

@Serializable
data class CallStateResponse(val accountId: String, val call: CallResponse? = null)
