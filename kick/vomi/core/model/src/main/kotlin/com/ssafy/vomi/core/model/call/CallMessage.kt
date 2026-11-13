package com.ssafy.vomi.core.model.call

data class CallMessage(val id: Long, val speaker: CallSpeaker, val text: String)

enum class CallSpeaker { Local, Remote }
