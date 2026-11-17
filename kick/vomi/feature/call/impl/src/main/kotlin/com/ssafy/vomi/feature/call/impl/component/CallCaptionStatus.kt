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
import com.ssafy.vomi.core.model.speech.SpeechActivity
import com.ssafy.vomi.core.model.speech.SpeechAvailability
import com.ssafy.vomi.core.model.speech.SpeechError
import com.ssafy.vomi.core.model.speech.SpeechModelStatus
import com.ssafy.vomi.feature.call.impl.R
import com.ssafy.vomi.feature.call.impl.model.CallUiState

@Composable
internal fun CallCaptionStatus(state: CallUiState, onRetry: () -> Unit, onPrepareModel: () -> Unit) {
    val speech = state.speech
    val errorText = when (speech.error) {
        SpeechError.Unsupported -> R.string.call_caption_unsupported
        SpeechError.AudioInputUnavailable -> R.string.call_caption_audio_unavailable
        SpeechError.LanguageUnavailable -> R.string.call_caption_language_unavailable
        SpeechError.PermissionDenied -> R.string.call_microphone_permission_denied
        SpeechError.AudioBusy -> R.string.call_caption_busy
        SpeechError.CaptionDeliveryFailed -> R.string.call_caption_delivery_failed
        SpeechError.DownloadFailed -> R.string.call_caption_download_failed
        SpeechError.RecognitionFailed -> R.string.call_caption_failed
        null -> if (speech.availability == SpeechAvailability.Unsupported) R.string.call_caption_unsupported else null
    }
    Column(modifier = Modifier.padding(horizontal = 20.dp)) {
        if (errorText != null) Text(stringResource(errorText), style = VomiTheme.typography.captionR12)
        when {
            speech.activity == SpeechActivity.Downloading -> Text(
                text = speech.downloadProgress?.let { stringResource(R.string.call_caption_download_progress, it) }
                    ?: stringResource(R.string.call_caption_preparing),
                style = VomiTheme.typography.captionR12,
            )
            speech.modelStatus == SpeechModelStatus.Scheduled -> Text(stringResource(R.string.call_caption_model_scheduled), style = VomiTheme.typography.captionR12)
            speech.modelStatus == SpeechModelStatus.Requested -> Text(stringResource(R.string.call_caption_model_requested), style = VomiTheme.typography.captionR12)
        }
        if (speech.error == SpeechError.LanguageUnavailable && speech.canDownloadModel) {
            if (state.isMicrophoneEnabled) {
                Text(stringResource(R.string.call_caption_model_mic_off), style = VomiTheme.typography.captionR12)
            } else if (!speech.isBusy) {
                Button(onClick = onPrepareModel) { Text(stringResource(R.string.call_caption_prepare_model)) }
            }
        } else if (speech.error != null && speech.error != SpeechError.Unsupported &&
            speech.error != SpeechError.LanguageUnavailable && !speech.isBusy && state.isMicrophoneEnabled) {
            Button(onClick = onRetry) { Text(stringResource(R.string.call_caption_retry)) }
        }
    }
}
