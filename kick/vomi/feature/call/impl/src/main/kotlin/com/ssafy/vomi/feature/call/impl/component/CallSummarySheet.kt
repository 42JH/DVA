package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.component.bottomsheet.BottomSheet
import com.ssafy.vomi.core.designsystem.component.bottomsheet.BottomSheetDefaults
import com.ssafy.vomi.core.designsystem.component.bottomsheet.rememberBottomSheetState
import com.ssafy.vomi.core.designsystem.icon.VomiIcons
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.core.model.call.CallSummary
import com.ssafy.vomi.feature.call.impl.R

@Composable
internal fun CallSummarySheet(summary: CallSummary?, onDismiss: () -> Unit) {
    val containerHeightPx = LocalWindowInfo.current.containerSize.height
    val maxSheetHeight = with(LocalDensity.current) { containerHeightPx.toDp() * 0.75f }
    BottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = Color(0xFF292832),
        dragHandle = { BottomSheetDefaults.DragHandle() },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = maxSheetHeight)
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = stringResource(R.string.call_summary_title),
                    style = VomiTheme.typography.titleSB18,
                    modifier = Modifier.weight(1f)
                )
                CallRoundButton(
                    icon = VomiIcons.Close,
                    description = stringResource(R.string.call_close),
                    onClick = onDismiss,
                    color = Color.Transparent
                )
            }
            if (summary == null) {
                Text(
                    text = stringResource(R.string.call_summary_empty),
                    color = VomiTheme.colors.gray400
                )
            } else {
                Text(text = summary.overview, style = VomiTheme.typography.bodySB16)
                Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    summary.highlights.forEach { point ->
                        Text(
                            text = "•  $point",
                            style = VomiTheme.typography.bodyR14
                        )
                    }
                }
            }
        }
    }
}
