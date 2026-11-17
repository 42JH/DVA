package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.ClickableSurface
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.core.model.ai.ReplyModelAvailability
import com.ssafy.vomi.core.model.ai.ReplyRecommendationError
import com.ssafy.vomi.feature.call.impl.R
import com.ssafy.vomi.feature.call.impl.model.CallPhase
import com.ssafy.vomi.feature.call.impl.model.CallUiState

/** Readiness and generation errors are displayed inside the conversation alongside recommendations. */
@Composable
internal fun ReplyRecommendationStatus(
    state: CallUiState,
    onCheckModel: () -> Unit,
    onPrepareModel: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val availability = state.replyModel.availability
    val error = state.replyModelError ?: state.replyGenerationError
    val active = state.phase == CallPhase.Active && !state.isActionPending
    val message = when {
        !active -> stringResource(R.string.call_reply_waiting_for_call)
        availability == ReplyModelAvailability.Checking -> stringResource(R.string.call_reply_checking)
        availability == ReplyModelAvailability.Downloading -> if (state.replyModel.downloadedBytes > 0) {
            stringResource(R.string.call_reply_download_progress, state.replyModel.downloadedBytes / 1_048_576)
        } else stringResource(R.string.call_reply_downloading)
        availability == ReplyModelAvailability.Downloadable -> stringResource(R.string.call_reply_downloadable)
        availability == ReplyModelAvailability.Unavailable || error == ReplyRecommendationError.Unavailable -> stringResource(R.string.call_reply_unavailable)
        error != null -> stringResource(when (error) {
            ReplyRecommendationError.Busy -> R.string.call_reply_busy
            ReplyRecommendationError.QuotaExceeded -> R.string.call_reply_quota
            ReplyRecommendationError.Background -> R.string.call_reply_foreground_required
            ReplyRecommendationError.ModelNotReady -> R.string.call_reply_model_not_ready
            ReplyRecommendationError.InvalidResponse -> R.string.call_reply_invalid_response
            else -> R.string.call_reply_failed
        })
        state.isGeneratingReplies -> stringResource(R.string.call_reply_generating)
        availability == ReplyModelAvailability.Available -> stringResource(R.string.call_reply_waiting_for_speech)
        else -> stringResource(R.string.call_reply_model_not_ready)
    }
    val action = when {
        !active || state.isReplyModelOperationPending || state.isGeneratingReplies || availability == ReplyModelAvailability.Checking -> null
        availability == ReplyModelAvailability.Downloading -> R.string.call_reply_check_again to onCheckModel
        availability == ReplyModelAvailability.Downloadable -> R.string.call_reply_prepare_model to onPrepareModel
        availability != ReplyModelAvailability.Available -> R.string.call_reply_check_again to onCheckModel
        error != null -> R.string.call_reply_retry to onRetry
        else -> null
    }
    Row(
        modifier = modifier.padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = message, style = VomiTheme.typography.captionR12,
            color = Color.White.copy(alpha = 0.6f), maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f))
        action?.let { (label, callback) ->
            ClickableSurface(onClick = callback, shape = RoundedCornerShape(8.dp),
                modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)) {
                Text(stringResource(label), style = VomiTheme.typography.bodySB14,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 12.dp))
            }
        }
    }
}
