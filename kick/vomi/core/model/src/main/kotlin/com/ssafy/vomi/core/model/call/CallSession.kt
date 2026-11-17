package com.ssafy.vomi.core.model.call

enum class CallStatus { REQUESTED, ACCEPTED, REJECTED, CANCELED, ENDED, EXPIRED }

data class CallSession(
    val id: String,
    val callerId: String,
    val calleeId: String,
    val status: CallStatus,
) {
    val isTerminal: Boolean get() = status != CallStatus.REQUESTED && status != CallStatus.ACCEPTED
    fun peerId(accountId: String): String = if (callerId == accountId) calleeId else callerId
}

enum class CallConnection { Stopped, Connecting, Connected, Reconnecting, Failed }

data class CallSignalingState(
    val accountId: String? = null,
    val session: CallSession? = null,
    val connection: CallConnection = CallConnection.Stopped,
    val isCreating: Boolean = false,
) {
    val canStartCall: Boolean get() = connection == CallConnection.Connected && !isCreating && session?.isTerminal != false
}

data class CallSnapshot(val accountId: String, val session: CallSession?)
