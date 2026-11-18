package com.ssafy.vomi.core.model.call

enum class CallMediaConnection { Disconnected, Connecting, Connected, Reconnecting, Failed }

data class CallMediaState(
    val callId: String? = null,
    val connection: CallMediaConnection = CallMediaConnection.Disconnected,
    val isPeerConnected: Boolean = false,
    val isMicrophoneEnabled: Boolean = false,
)
