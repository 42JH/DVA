package com.ssafy.vomi.core.model.call

data class CallMessage(
    val id: Long,
    val speaker: CallSpeaker,
    val text: String,
    val isFinal: Boolean = true,
    val textMessageId: String? = null,
    val delivery: CallMessageDelivery = CallMessageDelivery.Complete,
)

enum class CallSpeaker { Local, Remote }
