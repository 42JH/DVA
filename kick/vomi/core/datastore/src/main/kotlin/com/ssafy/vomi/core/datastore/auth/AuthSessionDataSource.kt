package com.ssafy.vomi.core.datastore.auth

import androidx.datastore.core.DataStore
import com.ssafy.vomi.core.datastore.AuthSessionPreferences
import com.ssafy.vomi.core.datastore.copy
import com.ssafy.vomi.core.datastore.model.AuthSession
import java.io.IOException
import javax.inject.Inject
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map

class AuthSessionDataSource @Inject constructor(
    private val preferences: DataStore<AuthSessionPreferences>,
) {
    val session: Flow<AuthSession> = preferences.data
        .catch { error ->
            if (error is IOException) emit(AuthSessionPreferences.getDefaultInstance()) else throw error
        }
        .map { AuthSession(it.accessToken, it.refreshToken, it.userId) }

    suspend fun saveSession(accessToken: String, refreshToken: String, userId: String) {
        require(accessToken.isNotBlank() && refreshToken.isNotBlank() && userId.isNotBlank())
        preferences.updateData { current ->
            current.copy {
                this.accessToken = accessToken
                this.refreshToken = refreshToken
                this.userId = userId
            }
        }
    }

    suspend fun clearSession() {
        preferences.updateData { AuthSessionPreferences.getDefaultInstance() }
    }
}
