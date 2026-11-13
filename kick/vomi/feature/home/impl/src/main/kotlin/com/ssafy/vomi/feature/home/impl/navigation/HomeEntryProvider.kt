package com.ssafy.vomi.feature.home.impl.navigation

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import com.ssafy.vomi.feature.home.api.navigation.HomeNavKey
import com.ssafy.vomi.feature.home.impl.HomeScreen

fun EntryProviderScope<NavKey>.homeEntry(onFriendClick: (Long) -> Unit = {}) {
    entry<HomeNavKey> { HomeScreen(onFriendClick = onFriendClick) }
}
