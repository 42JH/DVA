package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.ClickableSurface
import com.ssafy.vomi.core.designsystem.component.Icon
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.feature.call.impl.R
import com.ssafy.vomi.feature.call.impl.model.CallUiState
import com.ssafy.vomi.feature.call.impl.model.QuickReplyTab

@Composable
internal fun CallQuickReplies(
    state: CallUiState,
    onTabClick: (QuickReplyTab) -> Unit,
    onSuggestionClick: (Long) -> Unit,
    onBackchannelClick: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            modifier = Modifier
                .padding(horizontal = 10.dp)
                .selectableGroup()
        ) {
            QuickReplyTab.entries.forEach { tab ->
                val selected = state.quickReplyTab == tab
                val label =
                    stringResource(if (tab == QuickReplyTab.Suggestions) R.string.call_suggestions else R.string.call_backchannels)
                val accent = Color(0xFFB9D7FA)
                Box(
                    modifier = Modifier
                        .size(48.dp)
                        .selectable(
                            selected = selected,
                            onClick = { onTabClick(tab) },
                            role = Role.Tab
                        )
                        .semantics { contentDescription = label },
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(5.dp)
                    ) {
                        Icon(
                            painter = painterResource(if (tab == QuickReplyTab.Suggestions) R.drawable.ic_reply_suggestions else R.drawable.ic_backchannel),
                            contentDescription = null,
                            tint = if (tab == QuickReplyTab.Backchannels) Color.Unspecified
                            else if (selected) accent else Color.White.copy(alpha = 0.40f),
                            modifier = Modifier
                                .size(20.dp)
                                .alpha(if (tab == QuickReplyTab.Backchannels && !selected) 0.40f else 1f),
                        )
                        Box(
                            modifier = Modifier
                                .width(12.dp)
                                .height(2.dp)
                                .background(
                                    if (selected) accent else Color.Transparent,
                                    RoundedCornerShape(1.dp)
                                )
                        )
                    }
                }
            }
        }
        // A single horizontal row, with every chip reserving two text lines in either mode.
        val chipHeight = with(LocalDensity.current) {
            (VomiTheme.typography.bodySB14.lineHeight.toDp() * 2 + 16.dp).coerceAtLeast(48.dp)
        }
        val chipMaxWidth = 192.dp * LocalDensity.current.fontScale.coerceAtLeast(1f)
        val listState = rememberLazyListState()
        LaunchedEffect(state.quickReplyTab) { listState.scrollToItem(0) }
        LazyRow(
            state = listState,
            modifier = Modifier
                .fillMaxWidth()
                .height(chipHeight + 8.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.quickReplyTab == QuickReplyTab.Suggestions) {
                items(state.suggestions, key = { "suggestion-${it.id}" }) { reply ->
                    ReplyChip(
                        text = reply.text,
                        enabled = state.canType,
                        modifier = Modifier.widthIn(min = 60.dp, max = chipMaxWidth),
                        onClick = { onSuggestionClick(reply.id) },
                    )
                }
            } else {
                items(state.backchannels, key = { "backchannel-${it.id}" }) { reply ->
                    ReplyChip(
                        text = reply.text,
                        enabled = true,
                        modifier = Modifier.widthIn(min = 60.dp, max = chipMaxWidth),
                        onClick = { onBackchannelClick(reply.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ReplyChip(
    text: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val displayText = remember(text) { text.withHangulWrapOpportunities() }
    ClickableSurface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(12.dp),
        color = Color.White.copy(alpha = if (enabled) 0.14f else 0.06f),
        modifier = modifier
    ) {
        Box(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = displayText,
                style = VomiTheme.typography.bodySB14.copy(
                    lineBreak = LineBreak.Simple
                ),
                color = Color.White.copy(alpha = if (enabled) 1f else 0.35f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clearAndSetSemantics { this.text = AnnotatedString(text) },
            )
        }
    }
}
