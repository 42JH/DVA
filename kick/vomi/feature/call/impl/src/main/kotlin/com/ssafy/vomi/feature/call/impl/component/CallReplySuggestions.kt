package com.ssafy.vomi.feature.call.impl.component

import android.icu.text.BreakIterator
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.ClickableSurface
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.core.model.call.ReplySuggestion
import com.ssafy.vomi.feature.call.impl.R
import com.ssafy.vomi.feature.call.impl.model.CallUiState
import java.util.Locale
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.first

@Composable
internal fun CallReplySuggestions(
    state: CallUiState,
    onSuggestionClick: (Long) -> Unit,
    onSuggestionEdit: (Long) -> Unit,
    onDragStart: (Long, Offset) -> Unit,
    onDragMove: (Offset) -> Unit,
    onDragEnd: () -> Unit,
    onDragCancel: () -> Unit,
    onCheckModel: () -> Unit,
    onPrepareModel: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val candidates = if (state.isGeneratingReplies) (0..2).map { slot ->
        state.suggestions.find { it.position == slot }
            ?: ReplySuggestion(-(slot + 1L), "", isComplete = false, position = slot)
    } else state.suggestions.sortedBy { it.position }
    Column(modifier = modifier.fillMaxWidth().padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.call_suggestions), style = VomiTheme.typography.captionR12, color = Color.White.copy(alpha = 0.55f))
        candidates.forEach { reply ->
            androidx.compose.runtime.key(reply.id) {
                StreamingReplyCard(reply, state.canType, onSuggestionClick, onSuggestionEdit, onDragStart, onDragMove, onDragEnd, onDragCancel)
            }
        }
        if (state.replyGenerationError != null) {
            ReplyRecommendationStatus(state, onCheckModel, onPrepareModel, onRetry, Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun StreamingReplyCard(
    reply: ReplySuggestion,
    canType: Boolean,
    onClick: (Long) -> Unit,
    onEdit: (Long) -> Unit,
    onDragStart: (Long, Offset) -> Unit,
    onDragMove: (Offset) -> Unit,
    onDragEnd: () -> Unit,
    onDragCancel: () -> Unit,
) {
    val inspecting = LocalInspectionMode.current
    var shown by rememberSaveable(reply.id) { mutableStateOf(if (inspecting) reply.text else "") }
    val currentText by rememberUpdatedState(reply.text)
    LaunchedEffect(reply.id) {
        if (inspecting) return@LaunchedEffect
        val boundaries = BreakIterator.getCharacterInstance(Locale.KOREAN)
        while (isActive) {
            if (shown == currentText) snapshotFlow { currentText }.first { it != shown }
            // Incoming chunks can contain many characters or arrive faster than a frame. Keep display pacing independent.
            delay(24.milliseconds)
            val target = currentText
            if (!target.startsWith(shown)) shown = ""
            if (shown.length < target.length) {
                boundaries.setText(target)
                val end = boundaries.following(shown.length)
                if (end != BreakIterator.DONE) shown = target.substring(0, end)
            }
        }
    }
    val complete = reply.isComplete && shown == reply.text && shown.isNotBlank()
    val selectable = complete && canType
    val editLabel = stringResource(R.string.call_suggestion_edit)
    val description = stringResource(if (complete) R.string.call_reply_candidate_complete else R.string.call_reply_candidate_writing)
    ClickableSurface(
        onClick = { onClick(reply.id) }, enabled = selectable, shape = RoundedCornerShape(12.dp),
        color = Color.White.copy(alpha = if (selectable) 0.14f else 0.07f),
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .suggestionDragSource(reply.id, selectable, onDragStart, onDragMove, onDragEnd, onDragCancel)
            .semantics {
                stateDescription = description
                customActions = if (selectable) listOf(CustomAccessibilityAction(editLabel) { onEdit(reply.id); true }) else emptyList()
            },
    ) {
        Text(text = if (shown.isEmpty()) stringResource(R.string.call_reply_candidate_writing) else shown.withHangulWrapOpportunities(),
            style = VomiTheme.typography.bodyR14.copy(lineBreak = LineBreak.Simple),
            color = Color.White.copy(alpha = if (selectable) 1f else 0.6f), maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp)
                .clearAndSetSemantics { text = AnnotatedString(shown) })
    }
}
