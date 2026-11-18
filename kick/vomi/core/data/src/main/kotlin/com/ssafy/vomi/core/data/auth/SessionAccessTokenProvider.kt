package com.ssafy.vomi.core.data.auth

import com.ssafy.vomi.core.network.auth.AccessTokenProvider
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SessionAccessTokenProvider @Inject constructor() : AccessTokenProvider {
    @Volatile private var token: String? = null

    override fun getAccessToken(): String? = token
    fun updateAccessToken(accessToken: String?) { token = accessToken?.takeIf(String::isNotBlank) }
    fun clearAccessToken() { token = null }
}
