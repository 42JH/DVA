package com.ssafy.vomi.feature.login.impl.navigation

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import com.ssafy.vomi.feature.login.api.navigation.LoginNavKey
import com.ssafy.vomi.feature.login.impl.LoginScreen

fun EntryProviderScope<NavKey>.loginEntry() {
    entry<LoginNavKey> { LoginScreen() }
}
