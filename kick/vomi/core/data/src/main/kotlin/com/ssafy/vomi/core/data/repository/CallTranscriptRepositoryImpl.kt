package com.ssafy.vomi.core.data.repository

import com.ssafy.vomi.core.model.call.CallTextPlayback
import com.ssafy.vomi.core.model.call.CallTextPlaybackStatus
import com.ssafy.vomi.core.model.call.CallCaption
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.CallMessageDelivery
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.core.model.call.CallTranscriptState
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

internal class CallTranscriptRepositoryImpl @Inject constructor() : CallTranscriptRepository {
    private val lock = Any()
    private val mutableState = MutableStateFlow(CallTranscriptState())
    override val transcriptState = mutableState.asStateFlow()
    private val entries = linkedMapOf<Key, Entry>()
    private var nextId = 0L
    private val pendingPlayback = linkedMapOf<Key, CallTextPlayback>()

    override fun beginCall(callId: String) = synchronized(lock) {
        if (mutableState.value.callId != callId) {
            entries.clear()
            pendingPlayback.clear()
            mutableState.value = CallTranscriptState(callId)
        }
    }

    override fun clearSession() = synchronized(lock) {
        entries.clear()
        pendingPlayback.clear()
        mutableState.value = CallTranscriptState()
    }

    override fun applyCaption(speaker: CallSpeaker, caption: CallCaption) = synchronized(lock) {
        if (mutableState.value.callId != caption.callId) return@synchronized
        val key = Key(speaker, caption.utteranceId, text = false)
        val previous = entries[key]
        if (previous != null && (previous.message.isFinal || previous.revision >= caption.revision)) return@synchronized
        if (caption.text.isEmpty()) entries.remove(key)
        else entries[key] = Entry(CallMessage(previous?.message?.id ?: ++nextId, speaker, caption.text, caption.isFinal), caption.revision)
        publish()
    }

    override fun discardPartialCaptions(callId: String) = synchronized(lock) {
        if (mutableState.value.callId == callId) {
            entries.entries.removeAll { !it.value.message.isFinal }
            publish()
        }
    }

    override fun putText(callId: String, messageId: String, speaker: CallSpeaker, text: String, delivery: CallMessageDelivery, playbackId: String?) = synchronized(lock) {
        if (mutableState.value.callId != callId) return@synchronized
        val key = Key(speaker, messageId, text = true)
        val previous = entries[key]
        if (previous != null) {
            require(previous.message.text == text) { "A text message ID cannot change its content" }
            return@synchronized
        }
        val playback = pendingPlayback.remove(key) ?: playbackId?.let { CallTextPlayback(it) }
        entries[key] = Entry(CallMessage(++nextId, speaker, text, textMessageId = messageId, delivery = delivery,
            playback = playback?.copy(spokenTextEnd = playback.spokenTextEnd.coerceIn(0, text.length))))
        publish()
    }

    override fun setTextDelivery(callId: String, messageId: String, delivery: CallMessageDelivery) = synchronized(lock) {
        if (mutableState.value.callId != callId) return@synchronized
        val key = Key(CallSpeaker.Local, messageId, text = true)
        val previous = entries[key] ?: return@synchronized
        entries[key] = previous.copy(message = previous.message.copy(delivery = delivery))
        publish()
    }

    override fun beginTextPlayback(callId: String, messageId: String, playbackId: String) = synchronized(lock) {
        if (mutableState.value.callId != callId) return@synchronized
        val key = Key(CallSpeaker.Local, messageId, text = true)
        val previous = entries[key] ?: return@synchronized
        entries[key] = previous.copy(message = previous.message.copy(playback = CallTextPlayback(playbackId)))
        publish()
    }

    override fun applyTextPlayback(callId: String, messageId: String, speaker: CallSpeaker, playback: CallTextPlayback) = synchronized(lock) {
        if (mutableState.value.callId != callId) return@synchronized
        val key = Key(speaker, messageId, text = true)
        val previous = entries[key]
        val old = previous?.message?.playback ?: pendingPlayback[key]
        if (speaker == CallSpeaker.Local && old?.playbackId != playback.playbackId) return@synchronized
        if (old?.playbackId == playback.playbackId && (old.sequence >= playback.sequence ||
                old.status == CallTextPlaybackStatus.Completed || old.status == CallTextPlaybackStatus.Interrupted)) return@synchronized
        val end = if (old?.playbackId == playback.playbackId) maxOf(old.spokenTextEnd, playback.spokenTextEnd) else playback.spokenTextEnd
        val updated = playback.copy(spokenTextEnd = end.coerceIn(0, previous?.message?.text?.length ?: 10_000))
        if (previous == null) {
            pendingPlayback[key] = updated
            while (pendingPlayback.size > 200) pendingPlayback.remove(pendingPlayback.keys.first())
        } else {
            entries[key] = previous.copy(message = previous.message.copy(playback = updated))
            publish()
        }
    }

    override fun interruptTextPlaybacks(callId: String) = synchronized(lock) {
        if (mutableState.value.callId != callId) return@synchronized
        entries.replaceAll { _, entry ->
            val playback = entry.message.playback
            if (playback?.status == CallTextPlaybackStatus.Queued || playback?.status == CallTextPlaybackStatus.Playing) {
                entry.copy(message = entry.message.copy(playback = playback.copy(sequence = playback.sequence + 1,
                    status = CallTextPlaybackStatus.Interrupted)))
            } else entry
        }
        pendingPlayback.clear()
        publish()
    }

    override fun setPlaybackError(callId: String, failed: Boolean) = synchronized(lock) {
        if (mutableState.value.callId == callId) mutableState.value = mutableState.value.copy(hasPlaybackError = failed)
    }

    private fun publish() {
        while (entries.size > 200) entries.remove(entries.keys.first())
        mutableState.value = mutableState.value.copy(messages = entries.values.map { it.message })
    }
    private data class Key(val speaker: CallSpeaker, val id: String, val text: Boolean)
    private data class Entry(val message: CallMessage, val revision: Long = 0)
}
