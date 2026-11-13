package com.ssafy.vomi.core.network.auth

import com.ssafy.vomi.core.network.NetworkConfig
import javax.inject.Inject
import okhttp3.Interceptor
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Response

class AccessTokenInterceptor @Inject constructor(
    private val accessTokenProvider: AccessTokenProvider,
) : Interceptor {
    private val apiUrl = NetworkConfig.BASE_URL.toHttpUrl()

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val url = request.url
        val isApiRequest = url.scheme == apiUrl.scheme && url.host == NetworkConfig.API_HOST &&
            url.port == apiUrl.port && url.encodedPath.startsWith(apiUrl.encodedPath)
        // Account selection supplies its own token before a session is established.
        if (!isApiRequest || request.header("Authorization") != null) return chain.proceed(request)
        val token = accessTokenProvider.getAccessToken()?.takeIf(String::isNotBlank)
            ?: return chain.proceed(request)
        return chain.proceed(request.newBuilder().header("Authorization", "Bearer $token").build())
    }
}
