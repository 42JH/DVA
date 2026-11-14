package com.ssafy.vomi.feature.home.impl.component

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.ssafy.vomi.core.designsystem.component.ClickableSurface
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.core.model.friend.Friend
import com.ssafy.vomi.feature.home.impl.R

@Composable
internal fun FriendListItem(
    friend: Friend,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    ClickableSurface(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {},
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val placeholder = painterResource(R.drawable.ic_profile_placeholder)
            val avatarColor = AvatarColors[(friend.id.hashCode() and Int.MAX_VALUE) % AvatarColors.size]
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(avatarColor),
            ) {
                AsyncImage(
                    model = friend.profileImageUrl,
                    contentDescription = null,
                    placeholder = placeholder,
                    error = placeholder,
                    fallback = placeholder,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Text(
                text = friend.name,
                style = VomiTheme.typography.bodyR16,
                color = VomiTheme.colors.typo,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

private val AvatarColors = listOf(
    Color(0xFF686D81),
    Color(0xFF626F79),
    Color(0xFF7D6C76),
    Color(0xFF746C84),
    Color(0xFF6D7A75),
    Color(0xFF86766B),
)
