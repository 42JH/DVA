package com.ssafy.vomi.core.model.auth

enum class TestAccount(val accountId: String) {
    User1("kick-test-1"),
    User2("kick-test-2"),
}

data class UserSession(val id: String, val displayName: String, val account: TestAccount)

enum class LoginError { MissingToken, InvalidToken, Network, Server, UnexpectedAccount }
