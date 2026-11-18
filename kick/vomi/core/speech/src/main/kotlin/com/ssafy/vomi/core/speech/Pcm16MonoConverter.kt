package com.ssafy.vomi.core.speech

import com.ssafy.vomi.core.model.speech.PcmAudioFrame
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.floor

/** Streaming downmix/resample. Fractional position is retained across RTC's 10 ms frames. */
internal class Pcm16MonoConverter {
    private var sampleRate = 0
    private var channels = 0
    private var position = 0.0
    private var previous = 0.0

    fun convert(frame: PcmAudioFrame): ByteArray {
        require(frame.sampleRate in 8_000..192_000 && frame.channelCount in 1..8)
        require(frame.data.size % (2 * frame.channelCount) == 0)
        if (sampleRate != frame.sampleRate || channels != frame.channelCount) {
            sampleRate = frame.sampleRate
            channels = frame.channelCount
            position = 0.0
            previous = 0.0
        }
        val input = ByteBuffer.wrap(frame.data).order(ByteOrder.LITTLE_ENDIAN)
        val samples = DoubleArray(frame.data.size / (2 * channels)) {
            var sum = 0.0
            repeat(channels) { sum += input.short.toDouble() }
            sum / channels
        }
        if (samples.isEmpty()) return byteArrayOf()
        val step = sampleRate / 16_000.0
        val output = ByteBuffer.allocate((samples.size / step + 3).toInt() * 2).order(ByteOrder.LITTLE_ENDIAN)
        while (position < samples.size) {
            val left = floor(position).toInt()
            val fraction = position - left
            if (left == samples.lastIndex && fraction > 0.000001) break
            val first = if (left < 0) previous else samples[left]
            val second = samples[(left + 1).coerceAtMost(samples.lastIndex)]
            output.putShort((first + (second - first) * fraction).toInt().coerceIn(-32768, 32767).toShort())
            position += step
        }
        position -= samples.size
        previous = samples.last()
        return output.array().copyOf(output.position())
    }
}
