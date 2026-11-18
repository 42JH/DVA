package com.ssafy.vomi.core.network.model.call

import kotlinx.serialization.Serializable

@Serializable
data class UpdateCallRequest(val action: CallAction)
