package com.ssafy.vomi.core.network.model.voice

import kotlinx.serialization.Serializable

@Serializable
data class CreateSpeechRequest(val text: String)
