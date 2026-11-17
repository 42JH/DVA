package com.ssafy.vomi.core.speech

import android.Manifest
import android.annotation.TargetApi
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.media.AudioFormat
import android.system.Os
import android.system.OsConstants
import android.system.ErrnoException
import com.ssafy.vomi.core.model.speech.PcmAudioFrame
import android.speech.ModelDownloadListener
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.ssafy.vomi.core.model.speech.SpeechCapability
import com.ssafy.vomi.core.model.speech.SpeechDownloadEvent
import com.ssafy.vomi.core.model.speech.SpeechError
import com.ssafy.vomi.core.model.speech.SpeechException
import com.ssafy.vomi.core.model.speech.SpeechEvent
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import java.io.Closeable
import java.io.IOException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

internal class AndroidOnDeviceSpeechClient @Inject constructor(
    @param:ApplicationContext private val context: Context,
) : SpeechClient {
    // Framework recognizer calls and listener ownership are confined to Main.
    private var activeOwner: Any? = null

    override suspend fun capability(): SpeechCapability = withContext(Dispatchers.Main.immediate) {
        val available = supported()
        SpeechCapability(available, available && Build.VERSION.SDK_INT >= 33)
    }


    override fun recognize(audio: Flow<PcmAudioFrame>): Flow<SpeechEvent> = flow {
        var ended = false
        do {
            emitAll(recognizeSession(audio) { ended = true })
            if (!ended) delay(250.milliseconds)
        } while (!ended)
    }

    private fun recognizeSession(audio: Flow<PcmAudioFrame>, onAudioEnded: () -> Unit): Flow<SpeechEvent> = channelFlow {
        val owner = Any()
        val finished = CompletableDeferred<SpeechException?>()
        var engine: SpeechRecognizer? = null
        var pipe: Array<ParcelFileDescriptor>? = null
        var writer: Job? = null
        var segmented = false
        fun current() = activeOwner === owner && !finished.isCompleted
        try {
            withContext(Dispatchers.Main.immediate) {
                if (!supported()) throw SpeechException(SpeechError.Unsupported)
                if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    throw SpeechException(SpeechError.PermissionDenied)
                }
                if (activeOwner != null) throw SpeechException(SpeechError.AudioBusy)
                activeOwner = owner
                val descriptors = ParcelFileDescriptor.createPipe()
                pipe = descriptors
                Os.fcntlInt(descriptors[1].fileDescriptor, OsConstants.F_SETFL, OsConstants.O_NONBLOCK)
                val recognizer = createRecognizer()
                engine = recognizer
                val intent = recognitionIntent().apply {
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, descriptors[0])
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16_000)
                    putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
                }
                recognizer.setRecognitionListener(object : RecognitionCallbacks() {
                    override fun onReadyForSpeech(params: Bundle?) {
                        if (current()) trySend(SpeechEvent.Listening)
                    }
                    override fun onBeginningOfSpeech() {
                        if (current()) trySend(SpeechEvent.Listening)
                    }
                    override fun onEndOfSpeech() {
                        if (current()) trySend(SpeechEvent.Finalizing)
                    }
                    override fun onPartialResults(results: Bundle?) {
                        if (current()) trySend(SpeechEvent.Partial(firstResult(results)))
                    }
                    override fun onSegmentResults(segmentResults: Bundle) {
                        if (!current()) return
                        segmented = true
                        val text = firstResult(segmentResults)
                        if (text.isNotEmpty()) trySend(SpeechEvent.Final(formatFinalSpeech(text)))
                    }
                    override fun onEndOfSegmentedSession() {
                        if (current()) finished.complete(null)
                    }
                    override fun onResults(results: Bundle?) {
                        if (!current()) return
                        // A segmented recognizer may also send an aggregate result: do not duplicate its segments.
                        if (!segmented) {
                            val text = firstResult(results)
                            if (text.isNotEmpty()) trySend(SpeechEvent.Final(formatFinalSpeech(text)))
                        }
                        finished.complete(null)
                    }
                    override fun onError(error: Int) {
                        if (!current()) return
                        val reason = when (error) {
                            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> null
                            SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE, SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> SpeechError.LanguageUnavailable
                            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> SpeechError.PermissionDenied
                            SpeechRecognizer.ERROR_AUDIO -> SpeechError.AudioInputUnavailable
                            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> SpeechError.AudioBusy
                            else -> SpeechError.RecognitionFailed
                        }
                        if (reason == null) trySend(SpeechEvent.Partial(""))
                        finished.complete(reason?.let { SpeechException(it) })
                    }
                })
                val support = withTimeoutOrNull(5_000.milliseconds) { recognitionSupport(recognizer, intent) }
                if (support == null) throw SpeechException(SpeechError.AudioInputUnavailable)
                if (support.installedOnDeviceLanguages.none(::isKorean)) throw SpeechException(SpeechError.LanguageUnavailable)
                trySend(SpeechEvent.Starting)
                recognizer.startListening(intent)
            }
            val output = checkNotNull(pipe)[1]
            writer = launch(Dispatchers.IO) {
                val converter = Pcm16MonoConverter()
                try {
                    audio.collect { frame ->
                        val bytes = converter.convert(frame)
                        var offset = 0
                        var blocked = 0
                        while (offset < bytes.size) {
                            currentCoroutineContext().ensureActive()
                            try {
                                offset += Os.write(output.fileDescriptor, bytes, offset, bytes.size - offset)
                                blocked = 0
                            } catch (error: ErrnoException) {
                                if (error.errno != OsConstants.EAGAIN) throw error
                                if (++blocked >= 100) throw SpeechException(SpeechError.AudioInputUnavailable)
                                delay(10.milliseconds)
                            }
                        }
                    }
                    onAudioEnded()
                    closeQuietly(output)
                    // Closing the supplied audio ends a segmented session and flushes its last sentence.
                    if (withTimeoutOrNull(2_000.milliseconds) { finished.await(); true } == null) finished.complete(null)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    finished.complete(if (error is SpeechException) error else SpeechException(SpeechError.AudioInputUnavailable, error))
                } finally {
                    closeQuietly(output)
                }
            }
            finished.await()?.let { throw it }
        } finally {
            withContext(NonCancellable) {
                writer?.cancelAndJoin()
                withContext(Dispatchers.Main.immediate) {
                    if (activeOwner === owner) activeOwner = null
                    engine?.destroy()
                    pipe?.forEach(::closeQuietly)
                }
            }
        }
    }.buffer(Channel.UNLIMITED)

    private fun closeQuietly(resource: Closeable) {
        try { resource.close() } catch (_: IOException) { }
    }

    override fun downloadKoreanModel(): Flow<SpeechDownloadEvent> = channelFlow {
        val owner = Any()
        val finished = CompletableDeferred<SpeechException?>()
        var engine: SpeechRecognizer? = null
        try {
            withContext(Dispatchers.Main.immediate) {
                if (!supported() || Build.VERSION.SDK_INT < 33) throw SpeechException(SpeechError.Unsupported)
                if (activeOwner != null) throw SpeechException(SpeechError.AudioBusy)
                activeOwner = owner
                val recognizer = createRecognizer()
                engine = recognizer
                recognizer.setRecognitionListener(object : RecognitionCallbacks() {})
                if (Build.VERSION.SDK_INT >= 34) {
                    recognizer.triggerModelDownload(recognitionIntent(), context.mainExecutor, object : ModelDownloadListener {
                        override fun onProgress(completedPercent: Int) {
                            if (activeOwner === owner && !finished.isCompleted) trySend(SpeechDownloadEvent.Progress(completedPercent.coerceIn(0, 100)))
                        }
                        override fun onSuccess() {
                            if (activeOwner === owner && !finished.isCompleted) {
                                trySend(SpeechDownloadEvent.Ready)
                                finished.complete(null)
                            }
                        }
                        override fun onScheduled() {
                            if (activeOwner === owner && !finished.isCompleted) {
                                trySend(SpeechDownloadEvent.Scheduled)
                                finished.complete(null)
                            }
                        }
                        override fun onError(error: Int) {
                            if (activeOwner === owner && !finished.isCompleted) finished.complete(SpeechException(SpeechError.DownloadFailed))
                        }
                    })
                } else {
                    recognizer.triggerModelDownload(recognitionIntent())
                    launch(Dispatchers.Main.immediate) {
                        val support = withTimeoutOrNull(5_000.milliseconds) { recognitionSupport(recognizer) }
                        if (activeOwner === owner && !finished.isCompleted) {
                            val event = when {
                                support?.installedOnDeviceLanguages?.any(::isKorean) == true -> SpeechDownloadEvent.Ready
                                support?.pendingOnDeviceLanguages?.any(::isKorean) == true -> SpeechDownloadEvent.Scheduled
                                else -> SpeechDownloadEvent.Requested
                            }
                            trySend(event)
                            finished.complete(null)
                        }
                    }
                }
            }
            finished.await()?.let { throw it }
        } finally {
            withContext(NonCancellable + Dispatchers.Main.immediate) {
                if (activeOwner === owner) activeOwner = null
                engine?.destroy()
            }
        }
    }.buffer(Channel.UNLIMITED)

    private fun supported(): Boolean = Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)

    @TargetApi(31)
    private fun createRecognizer(): SpeechRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)

    private fun recognitionIntent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ko-KR")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        if (Build.VERSION.SDK_INT >= 33) {
            putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_LATENCY)
            putExtra(RecognizerIntent.EXTRA_HIDE_PARTIAL_TRAILING_PUNCTUATION, true)
        }
    }

    @TargetApi(33)
    private suspend fun recognitionSupport(engine: SpeechRecognizer, intent: Intent = recognitionIntent()): RecognitionSupport? = suspendCancellableCoroutine { continuation ->
        engine.checkRecognitionSupport(intent, context.mainExecutor, object : RecognitionSupportCallback {
            override fun onSupportResult(recognitionSupport: RecognitionSupport) {
                if (continuation.isActive) continuation.resume(recognitionSupport)
            }
            override fun onError(error: Int) {
                if (continuation.isActive) continuation.resume(null)
            }
        })
    }

    private fun isKorean(language: String) = language.replace('_', '-').substringBefore('-').equals("ko", ignoreCase = true)
    private fun firstResult(results: Bundle?) = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()

    private abstract class RecognitionCallbacks : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onError(error: Int) = Unit
        override fun onResults(results: Bundle?) = Unit
        override fun onPartialResults(results: Bundle?) = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
    }
}
