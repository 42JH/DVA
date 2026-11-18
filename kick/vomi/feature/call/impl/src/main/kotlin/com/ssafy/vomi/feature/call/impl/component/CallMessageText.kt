package com.ssafy.vomi.feature.call.impl.component

import android.icu.text.BreakIterator
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.core.model.call.CallTextPlaybackStatus
import com.ssafy.vomi.feature.call.impl.R
import java.util.Locale

@Composable
internal fun CallMessageText(message: CallMessage, modifier: Modifier = Modifier) {
    val local = message.speaker == CallSpeaker.Local
    val color = if (local) Color(0xFFB9D7FA) else Color(0xFFF8F7FA)
    val playback = message.playback
    val spokenEnd = remember(message.text, playback?.spokenTextEnd, playback?.status) {
        if (playback?.status == CallTextPlaybackStatus.Completed) message.text.length
        else {
            val end = (playback?.spokenTextEnd ?: message.text.length).coerceIn(0, message.text.length)
            val boundaries = BreakIterator.getCharacterInstance(Locale.KOREAN).apply { setText(message.text) }
            if (boundaries.isBoundary(end)) end else boundaries.preceding(end).coerceAtLeast(0)
        }
    }
    val waiting = playback?.status == CallTextPlaybackStatus.Queued
    val showRemainder = local || playback?.status == CallTextPlaybackStatus.Interrupted
    val displayed = remember(message.text, playback, spokenEnd, showRemainder) {
        buildAnnotatedString {
            append(if (playback == null || showRemainder || playback.status == CallTextPlaybackStatus.Completed) message.text
                else message.text.substring(0, spokenEnd))
            if (playback != null && showRemainder && spokenEnd < length) {
                addStyle(SpanStyle(color = color.copy(alpha = 0.35f)), spokenEnd, length)
            }
        }
    }
    Column(modifier = modifier, horizontalAlignment = if (local) Alignment.End else Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (!local && playback != null && (waiting || displayed.isEmpty())) {
            Text(stringResource(R.string.call_speech_waiting), color = color.copy(alpha = 0.55f), style = VomiTheme.typography.bodyR16)
        } else {
            Text(displayed, color = color,
                style = VomiTheme.typography.bodyR16, textAlign = if (local) TextAlign.End else TextAlign.Start)
        }
        val status = when (playback?.status) {
            CallTextPlaybackStatus.Queued -> if (local) R.string.call_speech_peer_waiting else null
            CallTextPlaybackStatus.Playing -> R.string.call_speech_playing
            CallTextPlaybackStatus.Interrupted -> R.string.call_speech_interrupted
            else -> null
        }
        status?.let {
            Text(stringResource(it), style = VomiTheme.typography.captionR12, color = color.copy(alpha = 0.5f))
        }
    }
}
