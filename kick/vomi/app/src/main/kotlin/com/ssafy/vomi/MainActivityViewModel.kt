package com.ssafy.vomi

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ssafy.vomi.core.common.result.Result
import com.ssafy.vomi.core.common.result.asResult
import com.ssafy.vomi.core.data.repository.AuthRepository
import com.ssafy.vomi.core.data.repository.CallRepository
import com.ssafy.vomi.core.data.repository.UserRepository
import com.ssafy.vomi.core.data.repository.SpeechRepository
import com.ssafy.vomi.core.model.call.CallMediaConnection
import com.ssafy.vomi.core.model.call.CallStatus
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
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
internal class MainActivityViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val userRepository: UserRepository,
    private val callRepository: CallRepository,
    private val speechRepository: SpeechRepository,
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
                speechRepository.clearSession()
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
                        launch {
                            foreground.collectLatest { visible ->
                                if (visible) {
                                    callRepository.observeMedia().asResult().collect { result ->
                                        if (result is Result.Error && (result.exception as? HttpException)?.code() == 401) {
                                            authRepository.logout()
                                        }
                                    }
                                }
                            }
                        }
                        launch {
                            foreground.collectLatest { visible ->
                                if (visible) {
                                    callState.map { signaling ->
                                        signaling.session?.takeIf {
                                            signaling.accountId == state.userId && it.status == CallStatus.ACCEPTED &&
                                                signaling.media.callId == it.id && signaling.media.connection == CallMediaConnection.Connected
                                        }?.let { it.id to it.peerId(state.userId) }
                                    }.distinctUntilChanged().collectLatest { call ->
                                        if (call != null) {
                                            val (callId, peerId) = call
                                            val microphoneEnabled = callState.map {
                                                it.accountId == state.userId && it.session?.id == callId &&
                                                    it.media.callId == callId && it.media.connection == CallMediaConnection.Connected &&
                                                    it.media.isMicrophoneEnabled
                                            }
                                            speechRepository.observeCall(callId, peerId, microphoneEnabled).asResult().collect { }
                                        }
                                    }
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
