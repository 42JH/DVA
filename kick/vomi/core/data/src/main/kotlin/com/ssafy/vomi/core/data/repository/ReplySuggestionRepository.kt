package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.ai.ReplyModelState
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.ReplySuggestion
import kotlinx.coroutines.flow.Flow

interface ReplySuggestionRepository {
    fun checkModel(): Flow<ReplyModelState>
    fun prepareModel(): Flow<ReplyModelState>
    /** Streams candidate snapshots; only isComplete candidates may be selected or sent. */
    fun recommendReplies(messages: List<CallMessage>): Flow<List<ReplySuggestion>>
}
