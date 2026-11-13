package com.ssafy.vomi.core.navigation

import androidx.navigation3.runtime.NavKey

class Navigator(private val state: NavigationState) {
    fun navigate(key: NavKey) {
        state.backStack.add(key)
    }

    fun replaceAll(key: NavKey) {
        state.backStack.clear()
        state.backStack.add(key)
    }

    fun goBack() {
        if (state.canGoBack) state.backStack.removeLastOrNull()
    }
}
