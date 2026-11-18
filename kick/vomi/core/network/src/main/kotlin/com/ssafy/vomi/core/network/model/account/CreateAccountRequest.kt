package com.ssafy.vomi.core.network.model.account

import kotlinx.serialization.Serializable

@Serializable
class CreateAccountRequest(val displayName: String, val inviteCode: String)
