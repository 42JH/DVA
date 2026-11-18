package com.ssafy.vomi.core.network.service.account

import com.ssafy.vomi.core.network.auth.UnauthenticatedRequest
import com.ssafy.vomi.core.network.model.account.AccountResponse
import com.ssafy.vomi.core.network.model.account.CreateAccountRequest
import com.ssafy.vomi.core.network.model.account.CreateAccountResponse
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Tag

interface AccountService {
    @POST("api/accounts")
    suspend fun createAccount(
        @Body request: CreateAccountRequest,
        @Tag unauthenticated: UnauthenticatedRequest = UnauthenticatedRequest,
    ): CreateAccountResponse

    @GET("api/accounts/me")
    suspend fun getCurrentAccount(@Header("Authorization") authorization: String? = null): AccountResponse
}
