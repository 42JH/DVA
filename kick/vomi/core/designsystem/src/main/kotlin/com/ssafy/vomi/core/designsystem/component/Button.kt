package com.ssafy.vomi.core.designsystem.component

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.takeOrElse
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import com.ssafy.vomi.core.designsystem.theme.LocalVomiContentColor
import com.ssafy.vomi.core.designsystem.theme.VomiTheme

@Composable
fun Button(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = VomiButtonDefaults.DefaultShape,
    colors: ButtonColors = VomiButtonDefaults.buttonColors(),
    border: BorderStroke? = null,
    shadowElevation: Dp = 0.dp,
    contentPadding: PaddingValues = VomiButtonDefaults.ContentPadding,
    interactionSource: MutableInteractionSource? = null,
    content: @Composable RowScope.() -> Unit
) {
    @Suppress("NAME_SHADOWING")
    val interactionSource = interactionSource ?: remember { MutableInteractionSource() }
    val containerColor = if (enabled) colors.containerColor else colors.disabledContainerColor
    val contentColor = if (enabled) colors.contentColor else colors.disabledContentColor

    ClickableSurface(
        onClick = onClick,
        modifier = modifier.semantics { role = Role.Button },
        enabled = enabled,
        shape = shape,
        color = containerColor,
        shadowElevation = shadowElevation,
        border = border,
        interactionSource = interactionSource
    ) {
        ProvideContentColorTextStyle(
            contentColor = contentColor,
            textStyle = VomiTheme.typography.bodySB16
        ) {
            Row(
                Modifier
                    .padding(contentPadding),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
                content = content
            )
        }
    }
}

@Composable
private fun ProvideContentColorTextStyle(
    contentColor: Color,
    textStyle: TextStyle,
    content: @Composable () -> Unit
) {
    val mergedStyle = LocalVomiTextStyle.current.merge(textStyle)
    CompositionLocalProvider(
        LocalVomiContentColor provides contentColor,
        LocalVomiTextStyle provides mergedStyle,
        content = content
    )
}

@Preview
@Composable
private fun ButtonPreview() {
    VomiTheme {
        Button(
            modifier = Modifier
                .size(width = 320.dp, height = 54.dp),
            onClick = {},
        ) {
            Text(
                text = "내용 입력",
                style = VomiTheme.typography.titleSB18
            )
        }
    }
}

@Preview
@Composable
private fun DisabledButtonPreview() {
    VomiTheme {
        Button(
            enabled = false,
            modifier = Modifier
                .size(width = 320.dp, height = 54.dp),
            onClick = {},
        ) {
            Text(
                text = "내용 입력",
                style = VomiTheme.typography.titleSB18
            )
        }
    }
}

object VomiButtonDefaults {
    private val ButtonHorizontalPadding = 24.dp
    private val ButtonVerticalPadding = 8.dp

    val DefaultShape: Shape = RoundedCornerShape(5.dp)
    val ContentPadding =
        PaddingValues(
            horizontal = ButtonHorizontalPadding,
            vertical = ButtonVerticalPadding,
        )

    @Composable
    fun buttonColors(
        containerColor: Color = VomiTheme.colors.white,
        contentColor: Color = VomiTheme.colors.gray700,
        disabledContainerColor: Color = VomiTheme.colors.gray50,
        disabledContentColor: Color = VomiTheme.colors.gray700
    ): ButtonColors = ButtonColors(
        containerColor = containerColor,
        contentColor = contentColor,
        disabledContainerColor = disabledContainerColor,
        disabledContentColor = disabledContentColor
    )
}

@Immutable
class ButtonColors(
    val containerColor: Color,
    val contentColor: Color,
    val disabledContainerColor: Color,
    val disabledContentColor: Color,
) {
    fun copy(
        containerColor: Color = this.containerColor,
        contentColor: Color = this.contentColor,
        disabledContainerColor: Color = this.disabledContainerColor,
        disabledContentColor: Color = this.disabledContentColor
    ) = ButtonColors(
        containerColor.takeOrElse { this.containerColor },
        contentColor.takeOrElse { this.contentColor },
        disabledContainerColor.takeOrElse { this.disabledContainerColor },
        disabledContentColor.takeOrElse { this.disabledContentColor }
    )

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ButtonColors) return false

        if (containerColor != other.containerColor) return false
        if (contentColor != other.contentColor) return false
        if (disabledContainerColor != other.disabledContainerColor) return false
        if (disabledContentColor != other.disabledContentColor) return false

        return true
    }

    override fun hashCode(): Int {
        var result = containerColor.hashCode()
        result = 31 * result + contentColor.hashCode()
        result = 31 * result + disabledContainerColor.hashCode()
        result = 31 * result + disabledContentColor.hashCode()
        return result
    }
}
