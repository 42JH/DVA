package com.ssafy.vomi.core.rtc

import com.ssafy.vomi.core.model.call.CallCaption
import org.json.JSONException
import org.json.JSONObject

internal object CallCaptionCodec {
    const val TOPIC = "vomi.call.caption.v1"
    private const val MAX_BYTES = 12_000

    fun encode(caption: CallCaption): ByteArray {
        require(valid(caption))
        return JSONObject().put("callId", caption.callId).put("utteranceId", caption.utteranceId)
            .put("revision", caption.revision).put("text", caption.text).put("final", caption.isFinal)
            .toString().toByteArray(Charsets.UTF_8).also { require(it.size <= MAX_BYTES) }
    }

    fun decode(bytes: ByteArray, callId: String): CallCaption? {
        if (bytes.size > MAX_BYTES) return null
        return try {
            val json = JSONObject(bytes.toString(Charsets.UTF_8))
            if (json.opt("callId") !is String || json.opt("utteranceId") !is String ||
                json.opt("text") !is String || json.opt("final") !is Boolean || json.opt("revision") !is Number) return null
            CallCaption(json.getString("callId"), json.getString("utteranceId"), json.getLong("revision"),
                json.getString("text"), json.getBoolean("final"))
                .takeIf { it.callId == callId && valid(it) }
        } catch (_: JSONException) { null }
    }

    private fun valid(caption: CallCaption) = caption.callId.isNotBlank() &&
        caption.utteranceId.length in 1..100 && caption.revision >= 0 && caption.text.length <= 1_000 &&
        (caption.isFinal || caption.text.isNotBlank())
}
