package com.ssafy.vomi.core.network.service.friend

import com.ssafy.vomi.core.network.model.friend.FriendResponse
import javax.inject.Inject

class FriendClient @Inject constructor(private val friendService: FriendService) {
    suspend fun getFriends(): List<FriendResponse> = friendService.getFriends()

    suspend fun addFriend(friendId: String): FriendResponse = friendService.addFriend(friendId)
}
