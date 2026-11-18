package com.ssafy.vomi.core.network.service.device

import com.ssafy.vomi.core.network.model.device.PushTokenRequest
import retrofit2.http.Body
import retrofit2.http.HTTP
import retrofit2.http.PUT

interface DeviceService {
    @PUT("api/devices/push")
    suspend fun registerPushToken(@Body request: PushTokenRequest)

    @HTTP(method = "DELETE", path = "api/devices/push", hasBody = true)
    suspend fun unregisterPushToken(@Body request: PushTokenRequest)
}
