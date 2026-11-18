package com.ssafy.vomi.core.network.model.account

import kotlinx.serialization.Serializable

@Serializable
class CreateAccountResponse(val id: String, val displayName: String, val token: String) {
    override fun toString(): String = "CreateAccountResponse(id=$id, displayName=$displayName, token=[REDACTED])"
}
