package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.ClickableSurface
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.feature.call.impl.R
import com.ssafy.vomi.feature.call.impl.model.CallUiState

@Composable
internal fun CallQuickReplies(
    state: CallUiState,
    onSuggestionClick: (Long) -> Unit,
    onSuggestionEdit: (Long) -> Unit,
    onSuggestionDragStart: (Long, Offset) -> Unit,
    onSuggestionDragMove: (Offset) -> Unit,
    onSuggestionDragEnd: () -> Unit,
    onSuggestionDragCancel: () -> Unit,
    onBackchannelClick: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    val editActionLabel = stringResource(R.string.call_suggestion_edit)
    val rowHeight = with(LocalDensity.current) {
        (VomiTheme.typography.bodySB14.lineHeight.toDp() * 2 + 16.dp).coerceAtLeast(48.dp) + 8.dp
    }
    val chipMaxWidth = 192.dp * LocalDensity.current.fontScale.coerceAtLeast(1f)
    Column(
        modifier = modifier.fillMaxWidth(),
    ) {
        // The saved replies stay immediately available, including while the microphone is on.
        QuickReplyRow(
            label = stringResource(R.string.call_backchannels),
            height = rowHeight,
        ) {
            items(state.backchannels, key = { it.id }) { reply ->
                ReplyChip(
                    text = reply.text,
                    enabled = true,
                    containerColor = Color(0xFFFFE4A3).copy(alpha = 0.16f),
                    contentColor = Color.White,
                    modifier = Modifier.widthIn(min = 60.dp, max = chipMaxWidth),
                    onClick = { onBackchannelClick(reply.id) },
                )
            }
        }
        QuickReplyRow(
            label = stringResource(R.string.call_suggestions),
            height = rowHeight,
        ) {
            items(state.suggestions, key = { it.id }) { reply ->
                ReplyChip(
                    text = reply.text,
                    enabled = state.canType,
                    containerColor = Color.White.copy(alpha = 0.14f),
                    contentColor = Color.White,
                    modifier = Modifier
                        .widthIn(min = 60.dp, max = chipMaxWidth)
                        .suggestionDragSource(
                            id = reply.id,
                            enabled = state.canType,
                            onStart = onSuggestionDragStart,
                            onMove = onSuggestionDragMove,
                            onEnd = onSuggestionDragEnd,
                            onCancel = onSuggestionDragCancel,
                        )
                        .semantics {
                            customActions = if (state.canType) listOf(
                                CustomAccessibilityAction(editActionLabel) {
                                    onSuggestionEdit(reply.id)
                                    true
                                },
                            ) else emptyList()
                        },
                    onClick = { onSuggestionClick(reply.id) },
                )
            }
        }
    }
}

@Composable
private fun QuickReplyRow(
    label: String,
    height: Dp,
    content: LazyListScope.() -> Unit,
) {
    LazyRow(
        modifier = Modifier
            .fillMaxWidth()
            .height(height)
            .semantics { contentDescription = label },
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
private fun ReplyChip(
    text: String,
    enabled: Boolean,
    containerColor: Color,
    contentColor: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val displayText = remember(text) { text.withHangulWrapOpportunities() }
    ClickableSurface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(12.dp),
        color = containerColor.copy(alpha = if (enabled) containerColor.alpha else 0.06f),
        modifier = modifier,
    ) {
        Box(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = displayText,
                style = VomiTheme.typography.bodySB14.copy(lineBreak = LineBreak.Simple),
                color = contentColor.copy(alpha = if (enabled) 1f else 0.35f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clearAndSetSemantics { this.text = AnnotatedString(text) },
            )
        }
    }
}
