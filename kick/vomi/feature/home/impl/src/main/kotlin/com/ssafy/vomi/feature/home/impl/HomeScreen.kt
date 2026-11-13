package com.ssafy.vomi.feature.home.impl

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ssafy.vomi.core.designsystem.component.Button
import com.ssafy.vomi.core.designsystem.component.LoadingWheel
import com.ssafy.vomi.core.designsystem.component.Scaffold
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.component.VomiBackground
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.feature.home.impl.component.FriendListItem
import com.ssafy.vomi.feature.home.impl.model.HomeUiState
import com.ssafy.vomi.feature.home.impl.model.sampleFriends

@Composable
internal fun HomeScreen(
    onFriendClick: (Long) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: HomeViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    HomeContent(
        uiState = uiState,
        onFriendClick = onFriendClick,
        onRetryClick = viewModel::retry,
        modifier = modifier,
    )
}

@Composable
private fun HomeContent(
    uiState: HomeUiState,
    onFriendClick: (Long) -> Unit,
    onRetryClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // The app owns the full-screen background and safe-area insets.
    Column(modifier = modifier.fillMaxSize()) {
        Text(
            text = stringResource(R.string.home_title),
            style = VomiTheme.typography.titleB22,
            modifier = Modifier.padding(20.dp),
        )
        when (uiState) {
            HomeUiState.Loading -> {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    LoadingWheel()
                }
            }
            is HomeUiState.Success -> {
                if (uiState.friends.isEmpty()) {
                    HomeMessage(text = stringResource(R.string.home_empty))
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(top = 4.dp, bottom = 16.dp),
                    ) {
                        items(items = uiState.friends, key = { it.id }, contentType = { "friend" }) { friend ->
                            FriendListItem(friend = friend, onClick = { onFriendClick(friend.id) })
                        }
                    }
                }
            }
            is HomeUiState.Error -> {
                Column(
                    modifier = Modifier.fillMaxSize().padding(28.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(text = stringResource(R.string.home_error))
                    Button(onClick = onRetryClick) { Text(text = stringResource(R.string.home_retry)) }
                }
            }
        }
    }
}

@Composable
private fun HomeMessage(text: String) {
    Box(
        modifier = Modifier.fillMaxSize().padding(28.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = text, color = VomiTheme.colors.gray400)
    }
}

@Preview(name = "Friends", widthDp = 393, heightDp = 800)
@Preview(name = "Friends - large text", widthDp = 393, heightDp = 800, fontScale = 1.5f)
@Composable
private fun HomeScreenPreview() {
    HomePreview(HomeUiState.Success(sampleFriends))
}

@Preview(name = "Empty friends", widthDp = 393, heightDp = 800)
@Composable
private fun HomeEmptyPreview() {
    HomePreview(HomeUiState.Success(emptyList()))
}

@Preview(name = "Loading friends", widthDp = 393, heightDp = 800)
@Composable
private fun HomeLoadingPreview() {
    HomePreview(HomeUiState.Loading)
}

@Preview(name = "Friends error", widthDp = 393, heightDp = 800)
@Composable
private fun HomeErrorPreview() {
    HomePreview(HomeUiState.Error(IllegalStateException("Preview")))
}

@Composable
private fun HomePreview(uiState: HomeUiState) {
    VomiTheme {
        VomiBackground {
            Scaffold(modifier = Modifier.fillMaxWidth()) { padding ->
                HomeContent(
                    uiState = uiState,
                    onFriendClick = {},
                    onRetryClick = {},
                    modifier = Modifier.padding(padding),
                )
            }
        }
    }
}
