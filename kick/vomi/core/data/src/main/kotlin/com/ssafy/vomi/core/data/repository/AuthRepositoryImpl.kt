package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.common.network.Dispatcher
import com.ssafy.vomi.core.common.network.VomiDispatcher
import com.ssafy.vomi.core.data.auth.AuthDataSource
import com.ssafy.vomi.core.data.auth.SessionAccessTokenProvider
import com.ssafy.vomi.core.datastore.auth.AuthSessionDataSource
import com.ssafy.vomi.core.model.auth.AuthLoginResult
import com.ssafy.vomi.core.model.auth.AuthState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.withContext
import javax.inject.Inject

internal class AuthRepositoryImpl @Inject constructor(
    private val authDataSource: AuthDataSource,
    private val authSessionDataSource: AuthSessionDataSource,
    private val sessionAccessTokenProvider: SessionAccessTokenProvider,
    @param:Dispatcher(VomiDispatcher.IO) private val ioDispatcher: CoroutineDispatcher,
) : AuthRepository {
    override val authState: Flow<AuthState> = authSessionDataSource.session
        .onEach { session ->
            sessionAccessTokenProvider.updateAccessToken(if (session.isSignedIn) session.accessToken else null)
        }
        .map { if (it.isSignedIn) AuthState.SignedIn(it.userId) else AuthState.SignedOut }
        .distinctUntilChanged()
        .flowOn(ioDispatcher)

    override fun login(credential: String): Flow<AuthLoginResult> = flow {
        val credentials = authDataSource.login(credential)
        currentCoroutineContext().ensureActive()
        authSessionDataSource.saveSession(
            credentials.accessToken,
            credentials.refreshToken,
            credentials.userId
        )
        sessionAccessTokenProvider.updateAccessToken(credentials.accessToken)
        emit(AuthLoginResult(credentials.userId))
    }.flowOn(ioDispatcher)

    override suspend fun logout() {
        withContext(ioDispatcher) {
            authSessionDataSource.clearSession()
            sessionAccessTokenProvider.clearAccessToken()
        }
    }
}
