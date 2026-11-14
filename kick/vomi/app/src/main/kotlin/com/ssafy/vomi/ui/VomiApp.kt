package com.ssafy.vomi.ui

import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.padding
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.awaitCancellation
import androidx.compose.runtime.getValue
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ssafy.vomi.feature.login.api.navigation.LoginNavKey
import com.ssafy.vomi.feature.login.impl.navigation.loginEntry
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import com.ssafy.vomi.core.designsystem.component.Scaffold
import com.ssafy.vomi.core.designsystem.component.VomiBackground
import com.ssafy.vomi.core.navigation.Navigator
import com.ssafy.vomi.core.navigation.rememberNavigationState
import com.ssafy.vomi.feature.call.api.navigation.CallNavKey
import com.ssafy.vomi.feature.call.impl.navigation.callEntry
import com.ssafy.vomi.feature.home.api.navigation.HomeNavKey
import com.ssafy.vomi.feature.home.impl.navigation.homeEntry

@Composable
fun VomiApp(viewModel: SessionViewModel = hiltViewModel()) {
    val navigationState = rememberNavigationState(LoginNavKey)
    val navigator = remember(navigationState) { Navigator(navigationState) }
    val currentUser by viewModel.currentUser.collectAsStateWithLifecycle()
    val callState by viewModel.callState.collectAsStateWithLifecycle()
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner, viewModel) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            viewModel.setForeground(true)
            try { awaitCancellation() } finally { viewModel.setForeground(false) }
        }
    }
    LaunchedEffect(currentUser?.id, callState.accountId, callState.session) {
        val currentKey = navigationState.backStack.lastOrNull()
        if (currentUser == null) {
            if (currentKey != LoginNavKey) navigator.replaceAll(LoginNavKey)
        } else {
            if (currentKey == LoginNavKey) navigator.replaceAll(HomeNavKey)
            if (callState.accountId == currentUser?.id) {
                val call = callState.session?.takeUnless { it.isTerminal }
                val callKey = navigationState.backStack.lastOrNull() as? CallNavKey
                if (call != null && callKey?.callId != call.id) {
                    if (callKey != null) navigator.goBack()
                    navigator.navigate(CallNavKey(call.id))
                } else if (call == null && callKey != null) navigator.goBack()
            }
        }
    }
    BackHandler(enabled = currentUser != null && navigationState.backStack.lastOrNull() == HomeNavKey) {
        viewModel.logout()
    }
    VomiBackground {
        // The Scaffold handles system bars. The navigation viewport alone handles the IME.
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            contentWindowInsets = WindowInsets.systemBars.union(WindowInsets.displayCutout),
        ) { padding ->
            NavDisplay(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .consumeWindowInsets(padding)
                    .imePadding(),
                backStack = navigationState.backStack,
                onBack = { if (navigationState.backStack.lastOrNull() !is CallNavKey) navigator.goBack() },
                entryDecorators = listOf(
                    rememberSaveableStateHolderNavEntryDecorator(),
                    rememberViewModelStoreNavEntryDecorator(),
                ),
                entryProvider = entryProvider {
                    loginEntry()
                    homeEntry()
                    callEntry()
                },
            )
        }
    }
}
