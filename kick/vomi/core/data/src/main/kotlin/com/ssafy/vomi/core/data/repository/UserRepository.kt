package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.user.UserProfile
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

interface UserRepository {
    val currentUserProfile: StateFlow<UserProfile?>
    fun getCurrentUser(): Flow<UserProfile>
    fun clearCurrentUserProfile()
}
