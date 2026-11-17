package com.ssafy.vomi.core.ai

import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import com.ssafy.vomi.core.model.ai.ReplyModelAvailability
import com.ssafy.vomi.core.model.ai.ReplyModelState
import com.ssafy.vomi.core.model.ai.ReplyRecommendationError
import com.ssafy.vomi.core.model.ai.ReplyRecommendationException
import javax.inject.Inject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** AICore/ML Kit types are confined to this module. No API key or cloud model is used. */
internal class GeminiNanoReplyRecommendationClient @Inject constructor() : ReplyRecommendationClient {
    private class Session(val id: String) {
        var model: GenerativeModel? = null
        var isWarmedUp = false
    }

    private val operationMutex = Mutex()
    private var session: Session? = null

    override fun openSession(sessionId: String): Flow<Unit> = flow {
        val ownedSession = operationMutex.withLock {
            // A new call may arrive before the previous ViewModel finishes clearing.
            session?.let(::closeSession)
            Session(sessionId).also { session = it }
        }
        try {
            emit(Unit)
            awaitCancellation()
        } finally {
            // Wait for any cancelled SDK operation before releasing its client.
            withContext(NonCancellable) {
                operationMutex.withLock {
                    if (session === ownedSession) session = null
                    closeSession(ownedSession)
                }
            }
        }
    }.flowOn(Dispatchers.IO)

    override suspend fun warmup(sessionId: String): ReplyModelAvailability = withModel(sessionId) { owned, model ->
        emit(prepareIfAvailable(owned, model))
    }.first()

    override fun downloadModel(sessionId: String): Flow<ReplyModelState> = withModel(sessionId) { owned, model ->
        val current = availability(model.checkStatus())
        when (current) {
            ReplyModelAvailability.Available -> emit(ReplyModelState(prepareIfAvailable(owned, model)))
            ReplyModelAvailability.Downloadable, ReplyModelAvailability.Downloading -> {
                owned.isWarmedUp = false
                emit(ReplyModelState(ReplyModelAvailability.Downloading))
                model.download().collect { progress ->
                    when (progress) {
                        is DownloadStatus.DownloadProgress -> emit(ReplyModelState(
                            ReplyModelAvailability.Downloading, progress.totalBytesDownloaded.coerceAtLeast(0),
                        ))
                        is DownloadStatus.DownloadFailed -> throw progress.e
                        else -> Unit
                    }
                }
                // Publish readiness only after the downloaded model has also warmed up.
                emit(ReplyModelState(prepareIfAvailable(owned, model)))
            }
            else -> throw ReplyRecommendationException(ReplyRecommendationError.Unavailable, current)
        }
    }

    override fun generate(sessionId: String, prompt: String): Flow<String> = withModel(sessionId) { owned, model ->
        val current = prepareIfAvailable(owned, model)
        if (current != ReplyModelAvailability.Available) {
            throw ReplyRecommendationException(ReplyRecommendationError.ModelNotReady, current)
        }
        val request = generateContentRequest(TextPart(prompt)) {
            temperature = 0.2f
            maxOutputTokens = 240
        }
        model.generateContentStream(request).collect { chunk ->
            val text = chunk.candidates.firstOrNull()?.text.orEmpty()
            if (text.isNotEmpty()) emit(text)
        }
    }

    private suspend fun prepareIfAvailable(owned: Session, model: GenerativeModel): ReplyModelAvailability {
        val current = availability(model.checkStatus())
        if (current != ReplyModelAvailability.Available) owned.isWarmedUp = false
        else if (!owned.isWarmedUp) {
            model.warmup()
            owned.isWarmedUp = true
        }
        return current
    }

    private fun closeSession(owned: Session) {
        val model = owned.model
        owned.model = null
        owned.isWarmedUp = false
        model?.close()
    }

    private fun <T> withModel(
        sessionId: String,
        block: suspend FlowCollector<T>.(Session, GenerativeModel) -> Unit,
    ): Flow<T> = flow {
        operationMutex.withLock {
            val owned = session?.takeIf { it.id == sessionId }
                ?: throw ReplyRecommendationException(ReplyRecommendationError.ModelNotReady)
            try {
                val model = owned.model ?: Generation.getClient().also { owned.model = it }
                block(owned, model)
            } catch (error: GenAiException) {
                // Translate only SDK-specific errors; cancellation and other failures propagate.
                val reason = when (error.errorCode) {
                    GenAiException.ErrorCode.BUSY -> ReplyRecommendationError.Busy
                    GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED -> ReplyRecommendationError.QuotaExceeded
                    GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED -> ReplyRecommendationError.Background
                    GenAiException.ErrorCode.NOT_SUPPORTED, GenAiException.ErrorCode.AICORE_INCOMPATIBLE,
                    GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE -> ReplyRecommendationError.Unavailable
                    GenAiException.ErrorCode.NOT_AVAILABLE -> ReplyRecommendationError.ModelNotReady
                    else -> ReplyRecommendationError.Failed
                }
                val modelAvailability = when (reason) {
                    ReplyRecommendationError.Unavailable -> ReplyModelAvailability.Unavailable
                    ReplyRecommendationError.ModelNotReady -> ReplyModelAvailability.Unknown
                    else -> null
                }
                throw ReplyRecommendationException(reason, modelAvailability, error)
            }
        }
    }.flowOn(Dispatchers.IO)

    private fun availability(status: Int): ReplyModelAvailability = when (status) {
        FeatureStatus.AVAILABLE -> ReplyModelAvailability.Available
        FeatureStatus.DOWNLOADABLE -> ReplyModelAvailability.Downloadable
        FeatureStatus.DOWNLOADING -> ReplyModelAvailability.Downloading
        else -> ReplyModelAvailability.Unavailable
    }
}
