package com.ssafy.vomi.feature.login.impl

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ssafy.vomi.core.common.result.Result
import com.ssafy.vomi.core.common.result.asResult
import com.ssafy.vomi.core.data.auth.LoginException
import com.ssafy.vomi.core.data.repository.AuthRepository
import com.ssafy.vomi.core.model.auth.LoginError
import com.ssafy.vomi.core.model.auth.TestAccount
import com.ssafy.vomi.feature.login.impl.model.LoginUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

@HiltViewModel
internal class LoginViewModel @Inject constructor(
    private val authRepository: AuthRepository,
) : ViewModel() {
    private val mutableState = MutableStateFlow(LoginUiState())
    val uiState = mutableState.asStateFlow()
    private var loginJob: Job? = null

    fun login(account: TestAccount) {
        if (loginJob?.isActive == true) return
        loginJob = viewModelScope.launch {
            authRepository.login(account).asResult().collect { result ->
                mutableState.value = when (result) {
                    Result.Loading -> LoginUiState(loadingAccount = account)
                    is Result.Success -> LoginUiState()
                    is Result.Error -> LoginUiState(
                        error = (result.exception as? LoginException)?.reason ?: LoginError.Server,
                    )
                }
            }
        }
    }
}
