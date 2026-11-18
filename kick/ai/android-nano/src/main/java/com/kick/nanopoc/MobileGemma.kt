package com.kick.nanopoc

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.coroutineContext

class MobileGemma(context: Context) {
    private val app = context.applicationContext
    private val weights = File(app.filesDir, "gemma-4-E2B-it.litertlm")
    private val lock = Mutex()
    private var engine: Engine? = null

    val hasModel: Boolean get() = weights.isFile

    suspend fun importModel(uri: Uri) = withContext(Dispatchers.IO) {
        lock.withLock {
            val name = app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null }
            require(name == weights.name) { "Android용 ${weights.name} 파일을 선택해 주세요." }
            val temp = File.createTempFile("gemma-", ".part", app.filesDir)
            try {
                val input = requireNotNull(app.contentResolver.openInputStream(uri)) { "모델 파일을 열 수 없어요." }
                input.use { source ->
                    temp.outputStream().use { destination ->
                        val buffer = ByteArray(1024 * 1024)
                        while (true) {
                            coroutineContext.ensureActive()
                            val size = source.read(buffer)
                            if (size < 0) break
                            destination.write(buffer, 0, size)
                        }
                    }
                }
                require(temp.length() > 0) { "모델 파일이 비어 있어요." }
                closeEngine()
                android.system.Os.rename(temp.path, weights.path)
            } finally {
                temp.delete()
            }
        }
    }

    suspend fun prepare() = withContext(Dispatchers.IO) {
        lock.withLock {
            if (engine != null) return@withLock
            check(hasModel) { "Gemma 모델 파일을 먼저 선택해 주세요." }
            val loaded = Engine(EngineConfig(
                modelPath = weights.path,
                backend = Backend.GPU(),
                maxNumTokens = 2048,
                cacheDir = app.cacheDir.path,
            ))
            try {
                loaded.initialize()
                engine = loaded
            } catch (error: Throwable) {
                runCatching { loaded.close() }
                throw error
            }
        }
    }

    fun streamReply(prompt: String, systemPrompt: String, maxOutputTokens: Int) = flow {
        lock.withLock {
            val loaded = checkNotNull(engine) { "먼저 Gemma를 로드해 주세요." }
            val config = ConversationConfig(
                systemInstruction = systemPrompt.takeIf(String::isNotBlank)?.let { Contents.of(it) },
                samplerConfig = SamplerConfig(topK = 10, topP = 0.95, temperature = 0.2),
                maxOutputToken = maxOutputTokens,
                thinkingConfig = ThinkingConfig(enableThinking = false),
            )
            loaded.createConversation(config).use { conversation ->
                conversation.sendMessageAsync(prompt).collect { chunk ->
                    emit(chunk.contents.contents.filterIsInstance<Content.Text>().joinToString("") { it.text })
                }
            }
        }
    }.flowOn(Dispatchers.IO)

    suspend fun release() = withContext(Dispatchers.IO) {
        lock.withLock { closeEngine() }
    }

    private fun closeEngine() {
        val loaded = engine
        engine = null
        loaded?.close()
    }
}
