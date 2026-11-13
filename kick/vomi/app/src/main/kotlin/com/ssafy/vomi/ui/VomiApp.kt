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
    LaunchedEffect(currentUser?.id) {
        val currentKey = navigationState.backStack.lastOrNull()
        if (currentUser == null && currentKey != LoginNavKey) navigator.replaceAll(LoginNavKey)
        else if (currentUser != null && currentKey == LoginNavKey) navigator.replaceAll(HomeNavKey)
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
                onBack = { navigator.goBack() },
                entryDecorators = listOf(
                    rememberSaveableStateHolderNavEntryDecorator(),
                    rememberViewModelStoreNavEntryDecorator(),
                ),
                entryProvider = entryProvider {
                    loginEntry()
                    homeEntry { friendId, friendName -> navigator.navigate(CallNavKey(friendId, friendName)) }
                    callEntry(onEndCall = navigator::goBack)
                },
            )
        }
    }
}
