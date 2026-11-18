package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.common.network.Dispatcher
import com.ssafy.vomi.core.common.network.VomiDispatcher
import com.ssafy.vomi.core.data.mapper.toModel
import com.ssafy.vomi.core.model.friend.Friend
import com.ssafy.vomi.core.network.service.friend.FriendClient
import javax.inject.Inject
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn

internal class FriendRepositoryImpl @Inject constructor(
    private val friendClient: FriendClient,
    @param:Dispatcher(VomiDispatcher.IO) private val ioDispatcher: CoroutineDispatcher,
) : FriendRepository {
    override fun getFriends(): Flow<List<Friend>> = flow {
        emit(friendClient.getFriends().map { it.toModel() })
    }.flowOn(ioDispatcher)
}
