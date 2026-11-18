package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.speech.SpeechState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

interface SpeechRepository {
    val speechState: StateFlow<SpeechState>
    /** App foreground owner collects once per connected call; microphone changes do not stop peer captions. */
    fun observeCall(callId: String, peerId: String, microphoneEnabled: Flow<Boolean>): Flow<Unit>
    fun downloadKoreanModel(): Flow<Unit>
    fun retryRecognition()
    fun clearSession()
}
