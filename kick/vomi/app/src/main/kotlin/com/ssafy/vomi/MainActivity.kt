package com.ssafy.vomi

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.ssafy.vomi.core.designsystem.component.LoadingWheel
import com.ssafy.vomi.core.designsystem.component.VomiBackground
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.core.model.auth.AuthState
import com.ssafy.vomi.feature.home.api.navigation.HomeNavKey
import com.ssafy.vomi.feature.login.api.navigation.LoginNavKey
import com.ssafy.vomi.ui.VomiApp
import com.ssafy.vomi.ui.rememberVomiAppState
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    private val viewModel: MainActivityViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.setForeground(true)
                try {
                    awaitCancellation()
                } finally {
                    viewModel.setForeground(false)
                }
            }
        }
        setContent {
            val authState by viewModel.authState.collectAsStateWithLifecycle()
            val callState by viewModel.callState.collectAsStateWithLifecycle()
            VomiTheme {
                when (val state = authState) {
                    AuthState.Initializing -> VomiBackground {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center,
                        ) { LoadingWheel() }
                    }

                    else -> key(state) {
                        val startKey = when (state) {
                            AuthState.SignedOut -> LoginNavKey
                            is AuthState.SignedIn -> HomeNavKey
                            AuthState.Initializing -> error("Authentication must be restored before navigation.")
                        }
                        val appState = rememberVomiAppState(
                            authState = state,
                            callState = callState,
                            startKey = startKey,
                        )
                        VomiApp(appState = appState, onLogout = viewModel::logout)
                    }
                }
            }
        }
    }
}
