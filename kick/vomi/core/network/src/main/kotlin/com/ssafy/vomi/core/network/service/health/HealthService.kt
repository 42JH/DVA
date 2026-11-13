package com.ssafy.vomi.core.network.service.health

import com.ssafy.vomi.core.network.auth.UnauthenticatedRequest
import com.ssafy.vomi.core.network.model.health.HealthResponse
import retrofit2.http.GET
import retrofit2.http.Tag

interface HealthService {
    @GET("health")
    suspend fun getHealth(@Tag unauthenticated: UnauthenticatedRequest = UnauthenticatedRequest): HealthResponse
}
