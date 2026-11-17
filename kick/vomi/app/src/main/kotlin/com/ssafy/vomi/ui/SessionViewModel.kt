package com.ssafy.vomi.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ssafy.vomi.core.common.result.Result
import com.ssafy.vomi.core.common.result.asResult
import com.ssafy.vomi.core.data.repository.AuthRepository
import com.ssafy.vomi.core.data.repository.CallRepository
import com.ssafy.vomi.core.data.repository.UserRepository
import com.ssafy.vomi.core.model.auth.AuthState
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import retrofit2.HttpException

@HiltViewModel
class SessionViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val userRepository: UserRepository,
    private val callRepository: CallRepository,
) : ViewModel() {
    val authState = authRepository.authState.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        AuthState.Initializing,
    )
    val callState = callRepository.callState
    private val foreground = MutableStateFlow(false)

    init {
        viewModelScope.launch {
            authState.collectLatest { state ->
                callRepository.clearSession()
                userRepository.clearCurrentUserProfile()
                if (state is AuthState.SignedIn) {
                    callRepository.beginSession(state.userId)
                    coroutineScope {
                        launch {
                            userRepository.getCurrentUser().asResult().collect { result ->
                                when (result) {
                                    is Result.Success -> if (result.data.id != state.userId) authRepository.logout()
                                    is Result.Error -> if ((result.exception as? HttpException)?.code() == 401) authRepository.logout()
                                    Result.Loading -> Unit
                                }
                            }
                        }
                        combine(foreground, callRepository.reconnectRequests) { visible, _ -> visible }
                            .collectLatest { visible ->
                                if (visible) {
                                    callRepository.observeCalls().asResult().collect { result ->
                                        if (result is Result.Error && (result.exception as? HttpException)?.code() == 401) {
                                            authRepository.logout()
                                        }
                                    }
                                }
                            }
                    }
                }
            }
        }
    }

    fun setForeground(foreground: Boolean) {
        this.foreground.value = foreground
    }

    fun logout() {
        if (callState.value.isCreating) return
        viewModelScope.launch { authRepository.logout() }
    }
}
