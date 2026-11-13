package com.ssafy.vomi.core.model.friend

data class Friend(
    val id: Long,
    val name: String,
    val profileImageUrl: String? = null,
)
