package com.ssafy.vomi.core.network.model.call

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class CallAction {
    @SerialName("accept") ACCEPT,
    @SerialName("reject") REJECT,
    @SerialName("cancel") CANCEL,
    @SerialName("end") END,
}
