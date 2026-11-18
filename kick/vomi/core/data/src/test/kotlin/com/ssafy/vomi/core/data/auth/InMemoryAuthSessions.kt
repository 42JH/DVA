package com.ssafy.vomi.core.data.auth

import androidx.datastore.core.DataStore
import com.ssafy.vomi.core.datastore.AuthSessionPreferences
import com.ssafy.vomi.core.datastore.auth.AuthSessionDataSource
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal class InMemoryAuthSessions {
    private val lock = Mutex()
    val preferences = MutableStateFlow(AuthSessionPreferences.getDefaultInstance())
    val source = AuthSessionDataSource(object : DataStore<AuthSessionPreferences> {
        override val data = preferences
        override suspend fun updateData(transform: suspend (AuthSessionPreferences) -> AuthSessionPreferences): AuthSessionPreferences =
            lock.withLock { transform(preferences.value).also { preferences.value = it } }
    })
}
