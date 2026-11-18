package com.ssafy.vomi.core.designsystem.component

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import com.ssafy.vomi.core.designsystem.theme.VomiTheme

/** Shared full-screen call background; content is responsible for its own safe-area insets. */
@Composable
fun VomiBackground(
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit = {},
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .drawWithCache {
                val base = Brush.verticalGradient(
                    0f to Color(0xFF08070C),
                    0.20f to Color(0xFF100D16),
                    0.46f to Color(0xFF282A40),
                    0.76f to Color(0xFF464652),
                    1f to Color(0xFF4C515B),
                )
                val warmth = Brush.radialGradient(
                    0f to Color(0xFF6C4B30).copy(alpha = 0.72f),
                    0.48f to Color(0xFF623E2C).copy(alpha = 0.38f),
                    1f to Color.Transparent,
                    center = Offset(size.width * 1.25f, size.height * 0.62f),
                    radius = size.height * 0.60f,
                )
                val upperShadow = Brush.verticalGradient(
                    0f to Color(0xFF08070C),
                    0.17f to Color(0xFF0D0813).copy(alpha = 0.85f),
                    0.47f to Color.Transparent,
                )
                onDrawBehind {
                    drawRect(base)
                    drawRect(warmth)
                    drawRect(upperShadow)
                }
            },
        content = content,
    )
}

@Preview(name = "Call background", widthDp = 393, heightDp = 800)
@Composable
private fun VomiBackgroundPreview() {
    VomiTheme { VomiBackground() }
}
