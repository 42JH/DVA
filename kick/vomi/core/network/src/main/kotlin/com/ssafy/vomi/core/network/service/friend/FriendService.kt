package com.ssafy.vomi.core.network.service.friend

import com.ssafy.vomi.core.network.model.friend.FriendResponse
import retrofit2.http.GET
import retrofit2.http.PUT
import retrofit2.http.Path

interface FriendService {
    @GET("api/friends")
    suspend fun getFriends(): List<FriendResponse>

    @PUT("api/friends/{friendId}")
    suspend fun addFriend(@Path("friendId") friendId: String): FriendResponse
}
