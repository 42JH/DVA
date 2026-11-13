package com.ssafy.vomi.core.data.auth

import com.ssafy.vomi.core.model.auth.TestAccount

/** Local debug credentials stay out of UI models and log output. */
class TestAccountCredentials(private val user1Token: String, private val user2Token: String) {
    fun tokenFor(account: TestAccount): String = when (account) {
        TestAccount.User1 -> user1Token
        TestAccount.User2 -> user2Token
    }
}
