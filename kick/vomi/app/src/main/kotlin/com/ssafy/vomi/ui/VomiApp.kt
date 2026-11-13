package com.ssafy.vomi.ui

import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
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
fun VomiApp() {
    val navigationState = rememberNavigationState(HomeNavKey)
    val navigator = remember(navigationState) { Navigator(navigationState) }
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
                    homeEntry { friendId, friendName -> navigator.navigate(CallNavKey(friendId, friendName)) }
                    callEntry(onEndCall = navigator::goBack)
                },
            )
        }
    }
}
