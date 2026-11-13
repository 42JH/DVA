package com.ssafy.vomi.core.network.model.call

import kotlinx.serialization.Serializable

@Serializable
class JoinCallResponse(val url: String, val token: String) {
    override fun toString(): String = "JoinCallResponse(url=$url, token=[REDACTED])"
}
