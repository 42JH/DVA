package com.ssafy.vomi.core.data.auth

import com.ssafy.vomi.core.model.auth.LoginError
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.network.service.account.AccountClient

/** Temporary login: a selected account ID stands in for a provider-issued credential. */
class MockAuthDataSource(
    private val accountClient: AccountClient,
    private val user1Token: String,
    private val user2Token: String,
) : AuthDataSource {
    override suspend fun login(credential: String): AuthCredentials {
        val accessToken = when (credential) {
            TestAccount.User1.accountId -> user1Token
            TestAccount.User2.accountId -> user2Token
            else -> throw LoginException(LoginError.UnexpectedAccount)
        }.trim()
        if (accessToken.isEmpty()) throw LoginException(LoginError.MissingToken)
        val account = accountClient.getCurrentAccount(accessToken)
        if (account.id != credential) throw LoginException(LoginError.UnexpectedAccount)
        // This placeholder is never sent to a refresh endpoint.
        return AuthCredentials(accessToken, "mock-refresh-token", account.id)
    }
}
