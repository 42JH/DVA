package com.ssafy.vomi.core.model.speech

enum class SpeechAvailability { Checking, Available, Unsupported }
enum class SpeechActivity { Idle, Starting, Listening, Finalizing, Downloading }
enum class SpeechModelStatus { Unknown, Requested, Scheduled, Ready }
enum class SpeechError { Unsupported, AudioInputUnavailable, LanguageUnavailable, PermissionDenied, AudioBusy, RecognitionFailed, DownloadFailed, CaptionDeliveryFailed }
data class SpeechCapability(val available: Boolean, val canDownloadModel: Boolean)

data class SpeechState(
    val callId: String? = null,
    val availability: SpeechAvailability = SpeechAvailability.Checking,
    val activity: SpeechActivity = SpeechActivity.Idle,
    val error: SpeechError? = null,
    val canDownloadModel: Boolean = false,
    val modelStatus: SpeechModelStatus = SpeechModelStatus.Unknown,
    val downloadProgress: Int? = null,
) {
    val isBusy: Boolean get() = activity != SpeechActivity.Idle
}

sealed interface SpeechEvent {
    data object Starting : SpeechEvent
    data object Listening : SpeechEvent
    data object Finalizing : SpeechEvent
    data class Partial(val text: String) : SpeechEvent
    data class Final(val text: String) : SpeechEvent
}

sealed interface SpeechDownloadEvent {
    data class Progress(val percent: Int) : SpeechDownloadEvent
    data object Ready : SpeechDownloadEvent
    data object Scheduled : SpeechDownloadEvent
    data object Requested : SpeechDownloadEvent
}
