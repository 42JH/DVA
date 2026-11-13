package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.friend.Friend
import kotlinx.coroutines.flow.Flow

interface FriendRepository {
    fun getFriends(): Flow<List<Friend>>
}
