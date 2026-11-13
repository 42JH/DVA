package com.ssafy.vomi.core.network.auth

import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Header

@Serializable
data class AccountResponse(val id: String, val displayName: String)

interface AccountApi {
    @GET("api/accounts/me")
    suspend fun me(@Header("Authorization") authorization: String): AccountResponse
}

interface AccessTokenProvider { fun accessToken(): String? }

data class AuthNetworkConfig(val baseUrl: String)
