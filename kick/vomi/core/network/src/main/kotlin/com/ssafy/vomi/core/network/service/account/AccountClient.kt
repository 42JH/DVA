package com.ssafy.vomi.core.network.service.account

import com.ssafy.vomi.core.network.model.account.AccountResponse
import javax.inject.Inject

class AccountClient @Inject constructor(private val accountService: AccountService) {
    /** An explicit token authenticates a selected test account; otherwise use the current session. */
    suspend fun getCurrentAccount(accessToken: String? = null): AccountResponse =
        accountService.getCurrentAccount(accessToken?.let { "Bearer $it" })
}
