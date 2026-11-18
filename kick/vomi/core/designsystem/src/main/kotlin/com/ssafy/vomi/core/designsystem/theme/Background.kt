package com.ssafy.vomi.core.designsystem.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import com.ssafy.vomi.core.designsystem.R

@Immutable
data class VomiBackground(
    val color: Color = Color.Unspecified,
    val tonalElevation: Dp = Dp.Unspecified,
) {
    companion object {
        @Composable
        fun defaultBackground(): VomiBackground =
            VomiBackground(
                color = colorResource(id = R.color.background),
                tonalElevation = 0.dp,
            )
    }
}

val LocalBackgroundTheme: ProvidableCompositionLocal<VomiBackground> =
    staticCompositionLocalOf { VomiBackground() }
