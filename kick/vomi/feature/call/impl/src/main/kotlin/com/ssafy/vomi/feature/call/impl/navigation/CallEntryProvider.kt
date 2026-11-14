package com.ssafy.vomi.feature.call.impl.navigation

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import com.ssafy.vomi.feature.call.api.navigation.CallNavKey
import com.ssafy.vomi.feature.call.impl.CallScreen

fun EntryProviderScope<NavKey>.callEntry() {
    entry<CallNavKey> { key -> CallScreen(callId = key.callId) }
}
