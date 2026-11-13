package com.ssafy.vomi.feature.home.impl

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ssafy.vomi.core.common.result.Result
import com.ssafy.vomi.core.common.result.asResult
import com.ssafy.vomi.core.data.repository.AuthRepository
import com.ssafy.vomi.core.data.repository.FriendRepository
import com.ssafy.vomi.feature.home.impl.model.HomeUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

@HiltViewModel
internal class HomeViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val friendRepository: FriendRepository,
) : ViewModel() {
    private val mutableState = MutableStateFlow<HomeUiState>(HomeUiState.Loading)
    val uiState: StateFlow<HomeUiState> = mutableState.asStateFlow()
    private var loadJob: Job? = null

    init { loadFriends() }

    fun retry() { loadFriends() }

    private fun loadFriends() {
        if (loadJob?.isActive == true) return
        loadJob = viewModelScope.launch {
            val currentUser = authRepository.currentUser.value
            friendRepository.getFriends().asResult().collect { result ->
                mutableState.value = when (result) {
                    Result.Loading -> HomeUiState.Loading
                    is Result.Success -> HomeUiState.Success(result.data, currentUser)
                    is Result.Error -> HomeUiState.Error(result.exception)
                }
            }
        }
    }
}
