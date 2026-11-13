package com.ssafy.vomi.feature.call.impl.navigation

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import com.ssafy.vomi.feature.call.api.navigation.CallNavKey
import com.ssafy.vomi.feature.call.impl.CallScreen

fun EntryProviderScope<NavKey>.callEntry(onEndCall: () -> Unit) {
    entry<CallNavKey> { key ->
        CallScreen(
            friendId = key.friendId,
            friendName = key.friendName,
            isIncoming = key.isIncoming,
            onEndCall = onEndCall
        )
    }
}
