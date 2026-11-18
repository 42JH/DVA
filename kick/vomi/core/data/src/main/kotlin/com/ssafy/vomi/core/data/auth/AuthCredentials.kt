package com.ssafy.vomi.core.data.auth

/** Login output used only by the data layer; tokens are not exposed through UI models. */
class AuthCredentials(
    val accessToken: String,
    val refreshToken: String,
    val userId: String,
) {
    override fun toString(): String = "AuthCredentials(userId=$userId, tokens=[REDACTED])"
}
