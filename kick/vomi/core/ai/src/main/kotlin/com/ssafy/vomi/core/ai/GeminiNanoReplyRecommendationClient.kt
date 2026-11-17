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
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** AICore/ML Kit types are confined to this module. No API key or cloud model is used. */
internal class GeminiNanoReplyRecommendationClient @Inject constructor() : ReplyRecommendationClient {
    private val operationMutex = Mutex()

    override suspend fun checkAvailability(): ReplyModelAvailability = withModel { model ->
        emit(availability(model.checkStatus()))
    }.first()

    override fun downloadModel(): Flow<ReplyModelState> = withModel { model ->
        val current = availability(model.checkStatus())
        when (current) {
            ReplyModelAvailability.Available -> emit(ReplyModelState(availability(model.checkStatus())))
            ReplyModelAvailability.Downloadable, ReplyModelAvailability.Downloading -> {
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
                emit(ReplyModelState(availability(model.checkStatus())))
            }
            else -> throw ReplyRecommendationException(ReplyRecommendationError.Unavailable, current)
        }
    }

    override fun generate(prompt: String): Flow<String> = withModel { model ->
        val current = availability(model.checkStatus())
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

    private fun <T> withModel(block: suspend FlowCollector<T>.(GenerativeModel) -> Unit): Flow<T> = flow {
        operationMutex.withLock {
            val model = Generation.getClient()
            try {
                block(model)
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
            } finally {
                model.close()
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
