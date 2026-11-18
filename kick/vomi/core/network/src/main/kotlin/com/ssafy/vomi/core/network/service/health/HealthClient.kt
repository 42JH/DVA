package com.ssafy.vomi.core.network.service.health

import com.ssafy.vomi.core.network.model.health.HealthResponse
import javax.inject.Inject

class HealthClient @Inject constructor(private val healthService: HealthService) {
    suspend fun getHealth(): HealthResponse = healthService.getHealth()
}
