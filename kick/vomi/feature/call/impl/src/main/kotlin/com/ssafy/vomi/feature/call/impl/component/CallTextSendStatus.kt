package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.Button
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.core.model.call.CallTextError
import com.ssafy.vomi.feature.call.impl.R
import com.ssafy.vomi.feature.call.impl.model.CallUiState

@Composable
internal fun CallTextSendStatus(state: CallUiState, onRetry: () -> Unit) {
    if (!state.isSendingText && state.textSendError == null && !state.hasPlaybackError) return
    Column(modifier = Modifier.padding(horizontal = 20.dp)) {
        if (state.isSendingText) Text(stringResource(R.string.call_text_sending), style = VomiTheme.typography.captionR12)
        state.textSendError?.let { error ->
            Text(stringResource(when (error) {
                CallTextError.InvalidText -> R.string.call_text_invalid
                CallTextError.VoiceNotReady -> R.string.call_text_voice_not_ready
                CallTextError.Authentication -> R.string.call_text_auth_error
                CallTextError.Network -> R.string.call_text_network_error
                CallTextError.Server -> R.string.call_text_server_error
                CallTextError.TextDelivery -> R.string.call_text_delivery_error
                CallTextError.InvalidAudio -> R.string.call_text_invalid_audio
                CallTextError.Busy -> R.string.call_text_busy
                CallTextError.CallUnavailable -> R.string.call_text_call_unavailable
                CallTextError.AudioDelivery -> R.string.call_text_audio_error
            }), style = VomiTheme.typography.captionR12)
            if (state.failedTextRequest != null && state.canType) {
                Button(onClick = onRetry) { Text(stringResource(R.string.call_text_retry)) }
            }
        }
        if (state.hasPlaybackError) Text(stringResource(R.string.call_text_receive_error), style = VomiTheme.typography.captionR12)
    }
}
