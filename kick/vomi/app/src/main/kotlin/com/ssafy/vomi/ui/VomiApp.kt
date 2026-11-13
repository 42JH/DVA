package com.ssafy.vomi.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import com.ssafy.vomi.core.navigation.Navigator
import com.ssafy.vomi.core.navigation.rememberNavigationState
import com.ssafy.vomi.feature.home.api.navigation.HomeNavKey
import com.ssafy.vomi.feature.home.impl.navigation.homeEntry

@Composable
fun VomiApp() {
    val navigationState = rememberNavigationState(HomeNavKey)
    val navigator = remember(navigationState) { Navigator(navigationState) }
    Scaffold(modifier = Modifier.fillMaxSize()) { padding ->
        NavDisplay(
            modifier = Modifier.padding(padding),
            backStack = navigationState.backStack,
            onBack = { navigator.goBack() },
            entryDecorators = listOf(
                rememberSaveableStateHolderNavEntryDecorator(),
                rememberViewModelStoreNavEntryDecorator(),
            ),
            entryProvider = entryProvider { homeEntry() },
        )
    }
}
