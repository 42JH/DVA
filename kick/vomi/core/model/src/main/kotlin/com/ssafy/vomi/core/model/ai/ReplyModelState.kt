package com.ssafy.vomi.core.model.ai

enum class ReplyModelAvailability { Unknown, Checking, Unavailable, Downloadable, Downloading, Available }

data class ReplyModelState(
    val availability: ReplyModelAvailability = ReplyModelAvailability.Unknown,
    val downloadedBytes: Long = 0,
)

enum class ReplyRecommendationError { Unavailable, ModelNotReady, Busy, QuotaExceeded, Background, InvalidResponse, Failed }

class ReplyRecommendationException(
    val reason: ReplyRecommendationError,
    val modelAvailability: ReplyModelAvailability? = null,
    cause: Throwable? = null,
) : Exception(reason.name, cause)
