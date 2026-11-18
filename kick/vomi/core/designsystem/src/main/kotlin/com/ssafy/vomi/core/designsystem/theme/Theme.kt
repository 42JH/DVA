package com.ssafy.vomi.core.designsystem.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import com.ssafy.vomi.core.designsystem.component.LocalVomiTextStyle

private val LocalVomiColors = staticCompositionLocalOf<VomiColors> {
    error("VomiTheme is required")
}
private val LocalVomiTypography = staticCompositionLocalOf<VomiTypography> {
    error("VomiTheme is required")
}
val LocalVomiContentColor = staticCompositionLocalOf { Color(0xFFF8F7FA) }

/** Provides design tokens without adding a layout or painting over screen backgrounds. */
@Composable
fun VomiTheme(
    colors: VomiColors = VomiColors.defaultColors(),
    typography: VomiTypography = VomiTypography.defaultTypography(),
    background: VomiBackground = VomiBackground.defaultBackground(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(
        LocalVomiColors provides colors,
        LocalVomiTypography provides typography,
        LocalBackgroundTheme provides background,
        LocalVomiContentColor provides colors.typo,
        LocalVomiTextStyle provides typography.bodyR16,
        content = content,
    )
}

object VomiTheme {
    val colors: VomiColors
        @Composable @ReadOnlyComposable get() = LocalVomiColors.current
    val typography: VomiTypography
        @Composable @ReadOnlyComposable get() = LocalVomiTypography.current
}
