package com.ssafy.vomi.core.designsystem.component

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.icon.VomiIcons
import com.ssafy.vomi.core.designsystem.theme.VomiTheme

@Preview(name = "Vomi components", widthDp = 393, heightDp = 800)
@Composable
private fun DesignSystemPreview() {
    VomiTheme {
        VomiBackground {
            Column(
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 64.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                Text(text = "Vomi", style = VomiTheme.typography.titleB22)
                Text(text = "나다운 목소리로 대화하세요.")
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(24.dp),
                    color = Color.White.copy(alpha = 0.10f),
                    contentColor = VomiTheme.colors.typo,
                ) {
                    Text(text = "공통 Surface", modifier = Modifier.padding(24.dp))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Button(onClick = {}) { Text(text = "확인") }
                    Button(onClick = {}, enabled = false) { Text(text = "확인") }
                    IconButton(
                        onClick = {},
                        painter = painterResource(VomiIcons.Close),
                        contentDescription = "닫기",
                        modifier = Modifier.size(48.dp),
                    )
                }
                HorizontalDivider()
            }
        }
    }
}
