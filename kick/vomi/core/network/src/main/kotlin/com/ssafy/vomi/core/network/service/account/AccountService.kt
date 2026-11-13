package com.ssafy.vomi.core.network.service.account

import com.ssafy.vomi.core.network.model.account.AccountResponse
import retrofit2.http.GET
import retrofit2.http.Header

interface AccountService {
    @GET("api/accounts/me")
    suspend fun getCurrentAccount(@Header("Authorization") authorization: String? = null): AccountResponse
}
