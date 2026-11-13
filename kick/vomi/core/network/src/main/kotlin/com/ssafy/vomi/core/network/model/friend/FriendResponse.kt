package com.ssafy.vomi.core.network.model.friend

import kotlinx.serialization.Serializable

@Serializable
data class FriendResponse(val id: String, val displayName: String)
