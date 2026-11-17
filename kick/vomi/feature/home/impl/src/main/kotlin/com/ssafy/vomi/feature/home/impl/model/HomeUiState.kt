package com.ssafy.vomi.feature.home.impl.model

import com.ssafy.vomi.core.model.friend.Friend
import com.ssafy.vomi.core.model.call.CallConnection
import com.ssafy.vomi.core.model.user.UserProfile

internal sealed interface HomeUiState {
    data object Loading : HomeUiState

    data class Success(
        val friends: List<Friend>,
        val currentUser: UserProfile? = null,
        val callConnection: CallConnection = CallConnection.Connected,
        val callingFriendId: String? = null,
        val callError: Boolean = false,
    ) : HomeUiState

    data class Error(val exception: Throwable) : HomeUiState
}
