package com.ssafy.vomi.ui

import androidx.lifecycle.ViewModel
import com.ssafy.vomi.core.data.repository.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class SessionViewModel @Inject constructor(private val auth: AuthRepository) : ViewModel() {
    val currentUser = auth.currentUser
    fun logout() = auth.logout()
}
