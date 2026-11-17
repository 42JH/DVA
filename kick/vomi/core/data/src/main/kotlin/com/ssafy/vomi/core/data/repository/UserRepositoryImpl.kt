package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.common.network.Dispatcher
import com.ssafy.vomi.core.common.network.VomiDispatcher
import com.ssafy.vomi.core.model.user.UserProfile
import com.ssafy.vomi.core.network.service.account.AccountClient
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import javax.inject.Inject

internal class UserRepositoryImpl @Inject constructor(
    private val client: AccountClient,
    @param:Dispatcher(VomiDispatcher.IO) private val io: CoroutineDispatcher,
) : UserRepository {
    private val mutableProfile = MutableStateFlow<UserProfile?>(null)
    override val currentUserProfile = mutableProfile.asStateFlow()
    override fun getCurrentUser(): Flow<UserProfile> = flow {
        val response = client.getCurrentAccount()
        currentCoroutineContext().ensureActive()
        val profile = UserProfile(response.id, response.displayName)
        mutableProfile.value = profile
        emit(profile)
    }.flowOn(io)

    override fun clearCurrentUserProfile() {
        mutableProfile.value = null
    }
}
