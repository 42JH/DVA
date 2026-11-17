package com.ssafy.vomi.core.ai

import com.ssafy.vomi.core.model.ai.ReplyModelAvailability
import com.ssafy.vomi.core.model.ai.ReplyModelState
import kotlinx.coroutines.flow.Flow

interface ReplyRecommendationClient {
    suspend fun checkAvailability(): ReplyModelAvailability
    fun downloadModel(): Flow<ReplyModelState>
    /** Incremental text chunks, not independently selectable answers. */
    fun generate(prompt: String): Flow<String>
}
