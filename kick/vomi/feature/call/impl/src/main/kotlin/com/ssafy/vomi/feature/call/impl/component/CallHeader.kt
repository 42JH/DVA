package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.Surface
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.feature.call.impl.R

@Composable
internal fun CallHeader(
    name: String,
    elapsedSeconds: Long,
    onSummaryClick: () -> Unit,
    onEndClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val timerStyle = VomiTheme.typography.captionR12.copy(fontFeatureSettings = "tnum")
    val textMeasurer = rememberTextMeasurer()
    val elapsedTime = "%02d:%02d".format(elapsedSeconds / 60, elapsedSeconds % 60)
    val timerWidth = with(LocalDensity.current) {
        textMeasurer.measure(
            text = elapsedTime,
            style = timerStyle,
            maxLines = 1,
            softWrap = false,
        ).size.width.toDp()
    }
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp),
        shape = RoundedCornerShape(28.dp),
        color = Color.White.copy(alpha = 0.10f),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CallRoundButton(
                icon = R.drawable.ic_call_summary,
                description = stringResource(R.string.call_show_summary),
                onClick = onSummaryClick
            )
            Row(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Mirror the timer's width to keep the name itself centered in the header.
                Spacer(modifier = Modifier.width(timerWidth))
                Text(
                    text = name,
                    style = VomiTheme.typography.titleSB18,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Text(
                    text = elapsedTime,
                    style = timerStyle,
                    modifier = Modifier.width(timerWidth),
                    textAlign = TextAlign.Start,
                    color = Color.White.copy(alpha = 0.60f),
                    maxLines = 1,
                    softWrap = false,
                )
            }
            CallRoundButton(
                icon = R.drawable.ic_call_end,
                description = stringResource(R.string.call_end),
                onClick = onEndClick,
                color = Color(0xFFDD3E36)
            )
        }
    }
}
