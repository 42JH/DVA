package com.ssafy.vomi.ui

import androidx.lifecycle.ViewModel
import com.ssafy.vomi.core.data.repository.AuthRepository
import com.ssafy.vomi.core.data.repository.CallRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class SessionViewModel @Inject constructor(
    private val auth: AuthRepository,
    private val calls: CallRepository,
) : ViewModel() {
    val currentUser = auth.currentUser
    val callState = calls.state
    fun setForeground(foreground: Boolean) = calls.setForeground(foreground)
    fun logout() { if (!calls.state.value.isCreating) auth.logout() }
}
