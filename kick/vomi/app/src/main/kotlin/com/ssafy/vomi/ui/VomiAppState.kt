package com.ssafy.vomi.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.navigation3.runtime.NavKey
import com.ssafy.vomi.core.model.auth.AuthState
import com.ssafy.vomi.core.model.call.CallSignalingState
import com.ssafy.vomi.core.navigation.NavigationState
import com.ssafy.vomi.core.navigation.Navigator
import com.ssafy.vomi.core.navigation.rememberNavigationState
import com.ssafy.vomi.feature.call.api.navigation.CallNavKey
import com.ssafy.vomi.feature.home.api.navigation.HomeNavKey
import com.ssafy.vomi.feature.login.api.navigation.LoginNavKey

@Composable
fun rememberVomiAppState(
    authState: AuthState,
    callState: CallSignalingState,
    startKey: NavKey,
): VomiAppState {
    val navigationState = rememberNavigationState(startKey)
    val currentAuthState = rememberUpdatedState(authState)
    val currentCallState = rememberUpdatedState(callState)
    return remember(navigationState) {
        VomiAppState(navigationState, currentAuthState, currentCallState)
    }
}

/** App UI state. Authentication and call connection work remain outside the composition. */
@Stable
class VomiAppState internal constructor(
    val navigationState: NavigationState,
    private val currentAuthState: State<AuthState>,
    private val currentCallState: State<CallSignalingState>,
) {
    private val navigator = Navigator(navigationState)

    val authState: AuthState get() = currentAuthState.value
    val callState: CallSignalingState get() = currentCallState.value
    val isSignedInHome: Boolean
        get() = authState is AuthState.SignedIn && navigationState.backStack.lastOrNull() == HomeNavKey

    fun updateNavigation() {
        val currentKey = navigationState.backStack.lastOrNull()
        when (val authentication = authState) {
            AuthState.Initializing -> Unit
            AuthState.SignedOut -> if (currentKey != LoginNavKey) navigator.replaceAll(LoginNavKey)
            is AuthState.SignedIn -> {
                if (currentKey == LoginNavKey) navigator.replaceAll(HomeNavKey)
                if (callState.accountId == authentication.userId) {
                    val call = callState.session?.takeUnless { it.isTerminal }
                    val callKey = navigationState.backStack.lastOrNull() as? CallNavKey
                    if (call != null && callKey?.callId != call.id) {
                        if (callKey != null) navigator.goBack()
                        navigator.navigate(CallNavKey(call.id))
                    } else if (call == null && callKey != null) {
                        navigator.goBack()
                    }
                }
            }
        }
    }

    fun onBack() {
        if (navigationState.backStack.lastOrNull() !is CallNavKey) navigator.goBack()
    }
}
