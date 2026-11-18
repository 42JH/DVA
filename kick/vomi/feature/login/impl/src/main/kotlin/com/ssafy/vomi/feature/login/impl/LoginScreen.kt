package com.ssafy.vomi.feature.login.impl

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ssafy.vomi.core.designsystem.component.Button
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.component.VomiBackground
import com.ssafy.vomi.core.designsystem.component.VomiButtonDefaults
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.core.model.auth.LoginError
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.feature.login.impl.model.LoginUiState

@Composable
internal fun LoginScreen(viewModel: LoginViewModel = hiltViewModel()) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    LoginContent(state = state, onAccountClick = viewModel::login)
}

@Composable
private fun LoginContent(state: LoginUiState, onAccountClick: (TestAccount) -> Unit) {
    BoxWithConstraints(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier
                .widthIn(max = 420.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .heightIn(min = maxHeight)
                .padding(horizontal = 28.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(text = stringResource(R.string.login_title), style = VomiTheme.typography.titleB22)
            Spacer(Modifier.height(12.dp))
            Text(
                text = stringResource(R.string.login_description),
                style = VomiTheme.typography.bodyR14,
                color = Color.White.copy(alpha = 0.65f),
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(32.dp))
            TestAccount.entries.forEachIndexed { index, account ->
                val name =
                    stringResource(if (account == TestAccount.User1) R.string.login_user_1 else R.string.login_user_2)
                Button(
                    onClick = { onAccountClick(account) },
                    enabled = !state.isLoading,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 56.dp),
                    shape = RoundedCornerShape(16.dp),
                    colors = VomiButtonDefaults.buttonColors(
                        containerColor = Color.White.copy(alpha = 0.16f),
                        contentColor = Color.White,
                        disabledContainerColor = Color.White.copy(alpha = 0.07f),
                        disabledContentColor = Color.White.copy(alpha = 0.45f),
                    ),
                ) {
                    Text(
                        text = if (state.loadingAccount == account) stringResource(
                            R.string.login_loading,
                            name
                        ) else name,
                        textAlign = TextAlign.Center
                    )
                }
                if (index == 0) Spacer(Modifier.height(12.dp))
            }
            state.error?.let { error ->
                Spacer(Modifier.height(20.dp))
                Text(
                    text = stringResource(
                        when (error) {
                            LoginError.MissingToken -> R.string.login_missing_token
                            LoginError.InvalidToken -> R.string.login_invalid_token
                            LoginError.Network -> R.string.login_network_error
                            LoginError.Server -> R.string.login_server_error
                            LoginError.UnexpectedAccount -> R.string.login_wrong_account
                        }
                    ),
                    style = VomiTheme.typography.bodyR14,
                    color = Color(0xFFFFC5B5),
                    textAlign = TextAlign.Center,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
        }
    }
}

@Preview(name = "Test login", widthDp = 393, heightDp = 800)
@Preview(name = "Test login - large text", widthDp = 360, heightDp = 640, fontScale = 1.5f)
@Composable
private fun LoginPreview() {
    LoginStatePreview(LoginUiState())
}

@Preview(name = "Logging in", widthDp = 393, heightDp = 800)
@Composable
private fun LoadingPreview() {
    LoginStatePreview(LoginUiState(loadingAccount = TestAccount.User1))
}

@Preview(name = "Login error", widthDp = 393, heightDp = 800)
@Composable
private fun ErrorPreview() {
    LoginStatePreview(LoginUiState(error = LoginError.InvalidToken))
}

@Composable
private fun LoginStatePreview(state: LoginUiState) {
    VomiTheme { VomiBackground { LoginContent(state, onAccountClick = {}) } }
}
