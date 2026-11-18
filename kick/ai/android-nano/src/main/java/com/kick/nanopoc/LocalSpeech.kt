package com.kick.nanopoc

import android.annotation.TargetApi
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.ModelDownloadListener
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

class LocalSpeech(
    private val context: Context,
    private val onState: (message: String, active: Boolean, canDownload: Boolean) -> Unit,
    private val onPartial: (String) -> Unit,
    private val onFinal: (String, Long?, Long) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ko-KR")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        if (Build.VERSION.SDK_INT >= 33) {
            putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_LATENCY)
            putExtra(RecognizerIntent.EXTRA_HIDE_PARTIAL_TRAILING_PUNCTUATION, true)
        }
    }
    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    private var downloading = false

    fun isAvailable(): Boolean = Build.VERSION.SDK_INT >= 31 &&
        SpeechRecognizer.isOnDeviceRecognitionAvailable(context)

    @TargetApi(31)
    fun start() {
        if (listening || downloading) return
        if (!isAvailable()) {
            onState("이 기기에서 온디바이스 음성 인식을 사용할 수 없어요.", false, false)
            return
        }
        try {
            val engine = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            recognizer = engine
            listening = true
            engine.setRecognitionListener(object : RecognitionListener {
                private var speechEndMs: Long? = null

                override fun onReadyForSpeech(params: Bundle?) {
                    if (recognizer === engine) onState("듣는 중 · 상대방처럼 말해 주세요.", true, false)
                }
                override fun onBeginningOfSpeech() {
                    speechEndMs = null
                }
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() {
                    if (recognizer === engine) {
                        speechEndMs = SystemClock.elapsedRealtime()
                        onState("자막 확정 중", true, false)
                    }
                }
                override fun onPartialResults(results: Bundle?) {
                    if (recognizer === engine) onPartial(firstResult(results))
                }
                override fun onResults(results: Bundle?) {
                    if (recognizer !== engine || !listening) return
                    val finalMs = SystemClock.elapsedRealtime()
                    val endMs = speechEndMs
                    speechEndMs = null
                    onPartial("")
                    firstResult(results).takeIf(String::isNotEmpty)?.let { onFinal(formatFinalSpeech(it), endMs, finalMs) }
                    listenAgain(engine)
                }
                override fun onError(error: Int) {
                    if (recognizer !== engine || !listening) return
                    speechEndMs = null
                    onPartial("")
                    when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> listenAgain(engine)
                        SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE, SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED ->
                            stop("한국어 음성 모델을 사용할 수 없어요. 음성 팩을 설치한 뒤 다시 시도하세요.", Build.VERSION.SDK_INT >= 33)
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> stop("설정에서 마이크 권한을 허용해 주세요.")
                        SpeechRecognizer.ERROR_AUDIO -> stop("마이크를 열 수 없어요. 다른 앱에서 사용 중인지 확인해 주세요.")
                        else -> stop("음성 인식 오류 ($error) · 마이크 시작을 다시 눌러 주세요.")
                    }
                }
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })
            onState("마이크 연결 중", true, false)
            engine.startListening(intent)
        } catch (error: RuntimeException) {
            stop("마이크를 시작하지 못했어요 · ${error.message.orEmpty()}")
        }
    }

    private fun firstResult(bundle: Bundle?) =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()

    private fun listenAgain(engine: SpeechRecognizer) {
        handler.postDelayed({
            if (recognizer === engine && listening) {
                try {
                    engine.startListening(intent)
                } catch (error: RuntimeException) {
                    stop("마이크를 다시 시작하지 못했어요 · ${error.message.orEmpty()}")
                }
            }
        }, 250)
    }

    @TargetApi(33)
    fun downloadKorean() {
        if (Build.VERSION.SDK_INT < 33 || listening || downloading || !isAvailable()) return
        try {
            val engine = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            recognizer = engine
            downloading = true
            onState("한국어 음성 팩 준비 중", false, false)
            if (Build.VERSION.SDK_INT >= 34) {
                engine.triggerModelDownload(intent, context.mainExecutor, object : ModelDownloadListener {
                    override fun onProgress(completedPercent: Int) {
                        if (recognizer === engine) onState("한국어 음성 팩 다운로드 중 · $completedPercent%", false, false)
                    }
                    override fun onSuccess() {
                        if (recognizer === engine) stop("한국어 음성 팩 준비됨 · 마이크 시작을 눌러 주세요.")
                    }
                    override fun onScheduled() {
                        if (recognizer === engine) stop("음성 팩 다운로드가 예약됐어요. 완료 후 마이크를 다시 시작하세요.", true)
                    }
                    override fun onError(error: Int) {
                        if (recognizer === engine) stop("음성 팩 다운로드 오류 ($error) · 다시 시도해 주세요.", true)
                    }
                })
            } else {
                engine.triggerModelDownload(intent)
                handler.postDelayed({
                    if (recognizer === engine) stop("음성 팩 다운로드를 요청했어요. 잠시 뒤 다시 시작하세요.", true)
                }, 1500)
            }
        } catch (error: RuntimeException) {
            stop("음성 팩을 준비하지 못했어요 · ${error.message.orEmpty()}", true)
        }
    }

    fun stop(message: String = "마이크 꺼짐", canDownload: Boolean = false) {
        listening = false
        downloading = false
        handler.removeCallbacksAndMessages(null)
        val engine = recognizer
        recognizer = null
        engine?.destroy()
        onPartial("")
        onState(message, false, canDownload)
    }
}
