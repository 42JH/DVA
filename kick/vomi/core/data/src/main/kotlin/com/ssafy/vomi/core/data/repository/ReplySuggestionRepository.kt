package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.ai.ReplyModelState
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.ReplySuggestion
import kotlinx.coroutines.flow.Flow

interface ReplySuggestionRepository {
    /** Collection owns a model client until call end or ViewModel cancellation. */
    fun openModelSession(sessionId: String): Flow<Unit>
    fun checkModel(sessionId: String): Flow<ReplyModelState>
    fun prepareModel(sessionId: String): Flow<ReplyModelState>
    /** Streams candidate snapshots; only isComplete candidates may be selected or sent. */
    fun recommendReplies(sessionId: String, messages: List<CallMessage>): Flow<List<ReplySuggestion>>
}
