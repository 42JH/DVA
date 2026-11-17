package com.ssafy.vomi.core.model.call

enum class CallMessageDelivery { Complete, Sending, TextSent, Failed, AudioFailed }
enum class CallTextError { InvalidText, VoiceNotReady, Authentication, Network, Server, TextDelivery, AudioDelivery, InvalidAudio, Busy, CallUnavailable }
class CallTextException(val reason: CallTextError, cause: Throwable? = null) : Exception(reason.name, cause)
data class CallTextRequest(val messageId: String, val text: String)
enum class CallTextSendStage { SendingText, TextSent, SendingAudio, Complete }
data class CallTextSendProgress(val messageId: String, val stage: CallTextSendStage)
data class CallTranscriptState(
    val callId: String? = null,
    val messages: List<CallMessage> = emptyList(),
    val hasPlaybackError: Boolean = false,
)
