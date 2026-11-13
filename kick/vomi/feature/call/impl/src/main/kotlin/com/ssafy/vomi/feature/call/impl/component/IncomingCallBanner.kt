package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.Surface
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.feature.call.impl.R

/** In-app incoming-call UI. A real signaling/notification source will supply the event later. */
@Composable
internal fun IncomingCallBanner(
    name: String,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(28.dp),
        color = Color(0xFF2A2933)
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                text = stringResource(R.string.call_incoming),
                style = VomiTheme.typography.captionR12,
                color = VomiTheme.colors.gray400
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(
                    text = name,
                    style = VomiTheme.typography.titleSB18,
                    modifier = Modifier.weight(1f)
                )
                CallRoundButton(
                    icon = R.drawable.ic_call_end,
                    description = stringResource(R.string.call_decline),
                    onClick = onDecline,
                    color = Color(0xFFDD3E36)
                )
                CallRoundButton(
                    icon = R.drawable.ic_call_answer,
                    description = stringResource(R.string.call_accept),
                    onClick = onAccept,
                    color = Color(0xFF299B65)
                )
            }
        }
    }
}
