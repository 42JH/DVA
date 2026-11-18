package com.ssafy.vomi.core.datastore.model

class AuthSession(
    val accessToken: String = "",
    val refreshToken: String = "",
    val userId: String = "",
) {
    val hasTokens: Boolean get() = accessToken.isNotBlank() && refreshToken.isNotBlank()
    val isSignedIn: Boolean get() = hasTokens && userId.isNotBlank()
    override fun toString(): String = "AuthSession(userId=$userId, tokens=[REDACTED])"
}
