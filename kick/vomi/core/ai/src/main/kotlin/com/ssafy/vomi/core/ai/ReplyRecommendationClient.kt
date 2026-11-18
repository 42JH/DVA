package com.ssafy.vomi.core.ai

import com.ssafy.vomi.core.model.ai.ReplyModelAvailability
import com.ssafy.vomi.core.model.ai.ReplyModelState
import kotlinx.coroutines.flow.Flow

interface ReplyRecommendationClient {
    /** Collect for the call lifetime. Cancellation releases this owner's model client. */
    fun openSession(sessionId: String): Flow<Unit>
    /** Checks availability and warms the retained client once, when the model is available. */
    suspend fun warmup(sessionId: String): ReplyModelAvailability
    fun downloadModel(sessionId: String): Flow<ReplyModelState>
    /** Incremental text chunks, not independently selectable answers. */
    fun generate(sessionId: String, prompt: String): Flow<String>
}
