package com.ssafy.vomi.feature.call.impl.component

import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.ClickableSurface
import com.ssafy.vomi.core.designsystem.component.Icon
import com.ssafy.vomi.core.designsystem.component.Surface

@Composable
internal fun CallRoundButton(
    @DrawableRes icon: Int,
    description: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    color: Color = Color.White.copy(alpha = 0.16f),
    tint: Color = Color.White,
    enabled: Boolean = true,
) {
    // Keep a 48dp touch target while making the visible control smaller.
    ClickableSurface(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.size(48.dp),
        shape = CircleShape,
    ) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Surface(
                modifier = Modifier.size(36.dp),
                shape = CircleShape,
                color = color,
                contentColor = tint
            ) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Icon(
                        painter = painterResource(icon),
                        contentDescription = description,
                        tint = tint,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }
    }
}
