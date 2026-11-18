package com.ssafy.vomi.core.model.auth

sealed interface AuthState {
    data object Initializing : AuthState
    data object SignedOut : AuthState
    data class SignedIn(val userId: String) : AuthState
}
