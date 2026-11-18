package com.ssafy.vomi.core.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.rememberNavBackStack

class NavigationState internal constructor(val backStack: NavBackStack<NavKey>) {
    val canGoBack: Boolean get() = backStack.size > 1
}

@Composable
fun rememberNavigationState(startKey: NavKey): NavigationState {
    val backStack = rememberNavBackStack(startKey)
    return remember(backStack) { NavigationState(backStack) }
}
