package com.ssafy.vomi.core.network.service.call

import com.ssafy.vomi.core.common.network.Dispatcher
import com.ssafy.vomi.core.common.network.VomiDispatcher
import com.ssafy.vomi.core.network.model.call.CallStateResponse
import java.io.IOException
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.ResponseBody
import okio.BufferedSource
import retrofit2.Call
import retrofit2.Callback
import retrofit2.HttpException
import retrofit2.Response

class CallEventsClient @Inject constructor(
    private val eventService: CallEventService,
    private val json: Json,
    @Dispatcher(VomiDispatcher.IO) private val ioDispatcher: CoroutineDispatcher,
) {
    /** Each collection opens a fresh snapshot stream. Caller decides when to reconnect or query active call. */
    fun events(): Flow<CallStateResponse> = callbackFlow {
        val call = eventService.getEvents()
        call.enqueue(object : Callback<ResponseBody> {
            override fun onFailure(call: Call<ResponseBody>, t: Throwable) { close(t) }

            override fun onResponse(call: Call<ResponseBody>, response: Response<ResponseBody>) {
                if (!response.isSuccessful) {
                    response.errorBody()?.close()
                    close(HttpException(response))
                    return
                }
                val body = response.body()
                if (body == null) {
                    close(IOException("Call event stream has no body"))
                    return
                }
                // Register cleanup on the reader even if the collection was cancelled before this callback.
                launch(ioDispatcher) {
                    try {
                        body.use {
                            readCallEvents(it.source(), json) { event -> send(event) }
                        }
                        close(IOException("Call event stream disconnected"))
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        // Socket reads fail when awaitClose cancels the call. Do not throw from this child,
                        // which could replace normal downstream cancellation with a socket exception.
                        close(error)
                    }
                }.invokeOnCompletion { cause ->
                    body.close()
                    if (cause != null) close(cause)
                }
            }
        })
        awaitClose { call.cancel() }
    }
}

/** Only complete named call events are emitted; comments, other events and incomplete EOF data are ignored. */
internal suspend fun readCallEvents(
    source: BufferedSource,
    json: Json,
    emit: suspend (CallStateResponse) -> Unit,
) {
    var eventName = ""
    val data = StringBuilder()
    var firstLine = true
    while (true) {
        currentCoroutineContext().ensureActive()
        var line = source.readUtf8Line() ?: return
        if (firstLine) { line = line.removePrefix("\uFEFF"); firstLine = false }
        if (line.isEmpty()) {
            if (eventName == "call" && data.isNotEmpty()) emit(json.decodeFromString<CallStateResponse>(data.toString()))
            eventName = ""
            data.clear()
            continue
        }
        if (line.startsWith(':')) continue
        val field = line.substringBefore(':')
        val value = line.substringAfter(':', "").removePrefix(" ")
        when (field) {
            "event" -> eventName = value
            "data" -> { if (data.isNotEmpty()) data.append('\n'); data.append(value) }
        }
    }
}
