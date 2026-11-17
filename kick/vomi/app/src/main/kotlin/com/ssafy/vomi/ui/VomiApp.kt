package com.ssafy.vomi.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import com.ssafy.vomi.core.designsystem.component.Scaffold
import com.ssafy.vomi.core.designsystem.component.VomiBackground
import com.ssafy.vomi.feature.call.impl.navigation.callEntry
import com.ssafy.vomi.feature.home.impl.navigation.homeEntry
import com.ssafy.vomi.feature.login.impl.navigation.loginEntry

@Composable
fun VomiApp(
    appState: VomiAppState,
    onLogout: () -> Unit,
) {
    LaunchedEffect(
        appState,
        appState.authState,
        appState.callState.accountId,
        appState.callState.session
    ) {
        appState.updateNavigation()
    }
    BackHandler(enabled = appState.isSignedInHome, onBack = onLogout)
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
                backStack = appState.navigationState.backStack,
                onBack = appState::onBack,
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
