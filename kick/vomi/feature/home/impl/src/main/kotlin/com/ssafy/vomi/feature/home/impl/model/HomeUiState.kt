package com.ssafy.vomi.feature.home.impl.model

import com.ssafy.vomi.core.model.friend.Friend
import com.ssafy.vomi.core.model.auth.UserSession

internal sealed interface HomeUiState {
    data object Loading : HomeUiState

    data class Success(val friends: List<Friend>, val currentUser: UserSession? = null) : HomeUiState

    data class Error(val exception: Throwable) : HomeUiState
}
