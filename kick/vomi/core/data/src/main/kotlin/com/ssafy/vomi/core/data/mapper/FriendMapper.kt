package com.ssafy.vomi.core.data.mapper

import com.ssafy.vomi.core.model.friend.Friend
import com.ssafy.vomi.core.network.model.friend.FriendResponse

internal fun FriendResponse.toModel(): Friend = Friend(id = id, name = displayName)
