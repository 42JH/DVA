package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.data.auth.TestAccountCredentials

import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.network.auth.AuthNetworkConfig
import com.ssafy.vomi.core.network.auth.AuthNetworkModule
import kotlinx.coroutines.flow.single
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Explicit opt-in, read-only GET /api/accounts/me; credentials never appear in test output. */
class AuthRepositoryLiveTest {
    @Test fun bothRuntimeChoicesAuthenticateAsTheirOwnServerAccount() = runTest {
        assumeTrue(System.getenv("VOMI_RUN_AUTH_LIVE_TESTS") == "1")
        val token1 = System.getenv("KICK_TEST_ACCOUNT_1_TOKEN").orEmpty()
        val token2 = System.getenv("KICK_TEST_ACCOUNT_2_TOKEN").orEmpty()
        require(token1.isNotBlank() && token2.isNotBlank()) { "Local test credentials are required" }
        val api = AuthNetworkModule.accountApi(AuthNetworkConfig("https://3.37.162.168/kick/"))
        val repository = AuthRepositoryImpl(api, TestAccountCredentials(token1, token2))
        repository.login(TestAccount.User1).single()
        assertEquals("kick-test-1", repository.currentUser.value!!.id)
        assertTrue(repository.accessToken() == token1)
        repository.logout()
        assertTrue(repository.accessToken() == null)
        repository.login(TestAccount.User2).single()
        assertEquals("kick-test-2", repository.currentUser.value!!.id)
        assertTrue(repository.accessToken() == token2)
        repository.logout()
    }
}
