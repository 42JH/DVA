package com.ssafy.vomi.core.network.model.account

import kotlinx.serialization.Serializable

@Serializable
data class AccountResponse(val id: String, val displayName: String)
