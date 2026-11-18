package com.ssafy.vomi.feature.call.api.navigation

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

@Serializable
data class CallNavKey(val callId: String) : NavKey
