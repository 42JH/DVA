package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.data.auth.LoginException
import com.ssafy.vomi.core.data.auth.TestAccountCredentials
import com.ssafy.vomi.core.model.auth.LoginError
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.core.model.auth.UserSession
import com.ssafy.vomi.core.data.auth.SessionAccessTokenProvider
import com.ssafy.vomi.core.network.service.account.AccountClient
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import retrofit2.HttpException

@Singleton
class AuthRepositoryImpl @Inject constructor(
    private val accountClient: AccountClient,
    private val credentials: TestAccountCredentials,
    private val sessionAccessTokenProvider: SessionAccessTokenProvider,
) : AuthRepository {
    private val mutableUser = MutableStateFlow<UserSession?>(null)
    override val currentUser = mutableUser.asStateFlow()

    override fun login(account: TestAccount): Flow<UserSession> = flow {
        val selectedToken = credentials.tokenFor(account).trim()
        if (selectedToken.isEmpty()) throw LoginException(LoginError.MissingToken)
        val response = try { accountClient.getCurrentAccount(selectedToken) }
        catch (e: CancellationException) { throw e }
        catch (e: HttpException) { throw LoginException(if (e.code() in listOf(401, 403)) LoginError.InvalidToken else LoginError.Server) }
        catch (e: IOException) { throw LoginException(LoginError.Network) }
        currentCoroutineContext().ensureActive()
        if (response.id != account.accountId) throw LoginException(LoginError.UnexpectedAccount)
        sessionAccessTokenProvider.updateAccessToken(selectedToken)
        val user = UserSession(response.id, response.displayName, account)
        mutableUser.value = user
        emit(user)
    }

    override fun logout() { sessionAccessTokenProvider.clearAccessToken(); mutableUser.value = null }
}
