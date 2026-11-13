package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.model.auth.UserSession
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

interface AuthRepository {
    val currentUser: StateFlow<UserSession?>
    fun login(account: TestAccount): Flow<UserSession>
    fun logout()
}
