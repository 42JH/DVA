package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.ClickableSurface
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.feature.call.impl.R
import com.ssafy.vomi.feature.call.impl.model.CallUiState

/** Only saved backchannels remain above the composer. AI replies belong to their conversation turn. */
@Composable
internal fun CallQuickReplies(state: CallUiState, onBackchannelClick: (Long) -> Unit, modifier: Modifier = Modifier) {
    val label = stringResource(R.string.call_backchannels)
    val rowHeight = with(LocalDensity.current) {
        (VomiTheme.typography.bodySB14.lineHeight.toDp() * 2 + 16.dp).coerceAtLeast(48.dp) + 8.dp
    }
    val chipMaxWidth = 192.dp * LocalDensity.current.fontScale.coerceAtLeast(1f)
    LazyRow(
        modifier = modifier.fillMaxWidth().height(rowHeight).semantics { contentDescription = label },
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items(state.backchannels, key = { it.id }) { reply ->
            val display = remember(reply.text) { reply.text.withHangulWrapOpportunities() }
            ClickableSurface(
                onClick = { onBackchannelClick(reply.id) }, enabled = state.canType,
                shape = RoundedCornerShape(12.dp),
                color = Color(0xFFFFE4A3).copy(alpha = if (state.canType) 0.16f else 0.06f),
                modifier = Modifier.widthIn(min = 60.dp, max = chipMaxWidth),
            ) {
                Box(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                    Text(text = display, style = VomiTheme.typography.bodySB14.copy(lineBreak = LineBreak.Simple),
                        color = Color.White.copy(alpha = if (state.canType) 1f else 0.35f), maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clearAndSetSemantics { text = AnnotatedString(reply.text) })
                }
            }
        }
    }
}
