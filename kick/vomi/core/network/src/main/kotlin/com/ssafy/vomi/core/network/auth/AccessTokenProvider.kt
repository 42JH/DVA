package com.ssafy.vomi.core.network.auth

interface AccessTokenProvider {
    fun getAccessToken(): String?
}
