package com.ssafy.vomi.core.network.service.device

import com.ssafy.vomi.core.network.model.device.PushTokenRequest
import javax.inject.Inject

class DeviceClient @Inject constructor(private val deviceService: DeviceService) {
    suspend fun registerPushToken(token: String) = deviceService.registerPushToken(PushTokenRequest(token))

    suspend fun unregisterPushToken(token: String) = deviceService.unregisterPushToken(PushTokenRequest(token))
}
