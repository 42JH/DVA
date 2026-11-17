package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.ai.ReplyRecommendationClient
import com.ssafy.vomi.core.common.network.Dispatcher
import com.ssafy.vomi.core.common.network.VomiDispatcher
import com.ssafy.vomi.core.data.reply.ReplyStreamParser
import com.ssafy.vomi.core.data.reply.buildReplyPrompt
import com.ssafy.vomi.core.model.ai.ReplyModelAvailability
import com.ssafy.vomi.core.model.ai.ReplyModelState
import com.ssafy.vomi.core.model.ai.ReplyRecommendationError
import com.ssafy.vomi.core.model.ai.ReplyRecommendationException
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.core.model.call.ReplySuggestion
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withTimeout

internal class ReplySuggestionRepositoryImpl @Inject constructor(
    private val replyRecommendationClient: ReplyRecommendationClient,
    @param:Dispatcher(VomiDispatcher.IO) private val ioDispatcher: CoroutineDispatcher,
) : ReplySuggestionRepository {
    private val nextSuggestionId = AtomicLong(0)

    override fun openModelSession(sessionId: String): Flow<Unit> = replyRecommendationClient.openSession(sessionId)

    override fun checkModel(sessionId: String): Flow<ReplyModelState> = flow {
        emit(ReplyModelState(ReplyModelAvailability.Checking))
        emit(ReplyModelState(replyRecommendationClient.warmup(sessionId)))
    }.flowOn(ioDispatcher)

    override fun prepareModel(sessionId: String): Flow<ReplyModelState> = replyRecommendationClient.downloadModel(sessionId).flowOn(ioDispatcher)

    override fun recommendReplies(sessionId: String, messages: List<CallMessage>): Flow<List<ReplySuggestion>> = flow {
        require(messages.isNotEmpty() && messages.all { it.isFinal } && messages.last().speaker == CallSpeaker.Remote && messages.last().text.isNotBlank())
        val output = StringBuilder()
        val parser = ReplyStreamParser()
        val ids = LongArray(3) { nextSuggestionId.incrementAndGet() }
        var snapshot = emptyList<ReplySuggestion>()
        withTimeout(30_000.milliseconds) {
            replyRecommendationClient.generate(sessionId, buildReplyPrompt(messages)).collect { chunk ->
                if (output.length + chunk.length > 8_000) throw ReplyRecommendationException(ReplyRecommendationError.InvalidResponse)
                output.append(chunk)
                val completed = mutableSetOf<String>()
                val next = parser.parse(output).mapNotNull { candidate ->
                    val normalized = candidate.text.filterNot(Char::isWhitespace).lowercase(Locale.ROOT)
                    if (candidate.isComplete && !completed.add(normalized)) null
                    else ReplySuggestion(ids[candidate.position], candidate.text, candidate.isComplete, candidate.position)
                }
                if (next != snapshot) {
                    snapshot = next
                    emit(snapshot)
                }
            }
        }
        val complete = snapshot.filter { it.isComplete }
        if (snapshot != complete) emit(complete)
        if (complete.isEmpty()) throw ReplyRecommendationException(ReplyRecommendationError.InvalidResponse)
    }.flowOn(ioDispatcher)
}
