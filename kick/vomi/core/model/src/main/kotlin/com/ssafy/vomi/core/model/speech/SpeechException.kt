package com.ssafy.vomi.core.model.speech

class SpeechException(val reason: SpeechError, cause: Throwable? = null) : Exception(reason.name, cause)
