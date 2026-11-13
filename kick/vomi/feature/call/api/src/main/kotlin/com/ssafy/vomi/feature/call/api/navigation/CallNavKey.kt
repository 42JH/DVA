package com.ssafy.vomi.feature.call.api.navigation

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

@Serializable
data class CallNavKey(
    val friendId: Long,
    val friendName: String,
    val isIncoming: Boolean = false,
) : NavKey
