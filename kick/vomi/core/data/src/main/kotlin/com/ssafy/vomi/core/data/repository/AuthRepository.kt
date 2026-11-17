package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.auth.AuthLoginResult
import com.ssafy.vomi.core.model.auth.AuthState
import kotlinx.coroutines.flow.Flow

interface AuthRepository {
    val authState: Flow<AuthState>
    fun login(credential: String): Flow<AuthLoginResult>
    suspend fun logout()
}
