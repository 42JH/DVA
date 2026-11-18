package com.ssafy.vomi.core.model.call

data class ReplySuggestion(
    val id: Long,
    val text: String,
    val isComplete: Boolean = true,
    val position: Int = 0,
)
