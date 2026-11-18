package com.ssafy.vomi.core.data.auth

/** Exchanges a login credential for tokens and the authenticated server user ID. */
interface AuthDataSource {
    suspend fun login(credential: String): AuthCredentials
}
