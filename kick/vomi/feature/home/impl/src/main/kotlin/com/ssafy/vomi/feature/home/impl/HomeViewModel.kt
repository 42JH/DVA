package com.ssafy.vomi.feature.home.impl

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ssafy.vomi.core.common.result.Result
import com.ssafy.vomi.core.common.result.asResult
import com.ssafy.vomi.core.data.repository.CallRepository
import com.ssafy.vomi.core.data.repository.FriendRepository
import com.ssafy.vomi.core.data.repository.UserRepository
import com.ssafy.vomi.feature.home.impl.model.HomeUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@HiltViewModel
internal class HomeViewModel @Inject constructor(
    private val userRepository: UserRepository,
    private val friendRepository: FriendRepository,
    private val callRepository: CallRepository,
) : ViewModel() {
    private val mutableState = MutableStateFlow<HomeUiState>(HomeUiState.Loading)
    val uiState: StateFlow<HomeUiState> = mutableState.asStateFlow()
    private var loadJob: Job? = null

    private var callJob: Job? = null
    private var pendingRequest: Pair<String, String>? = null

    init {
        loadFriends()
        viewModelScope.launch {
            combine(userRepository.currentUserProfile, callRepository.callState) { user, signaling -> user to signaling }.collect { (user, signaling) ->
                mutableState.update { state ->
                    if (state is HomeUiState.Success) state.copy(currentUser = user, callConnection = signaling.connection) else state
                }
            }
        }
    }

    fun callFriend(friendId: String) {
        if (callJob?.isActive == true) return
        val current = mutableState.value as? HomeUiState.Success ?: return
        if (!callRepository.callState.value.canStartCall || current.friends.none { it.id == friendId }) return
        val request = pendingRequest?.takeIf { it.first == friendId }
            ?: (friendId to UUID.randomUUID().toString()).also { pendingRequest = it }
        callJob = viewModelScope.launch {
            callRepository.createCall(friendId, request.second).asResult().collect { result ->
                mutableState.update { state ->
                    if (state !is HomeUiState.Success) state else when (result) {
                        Result.Loading -> state.copy(callingFriendId = friendId, callError = false)
                        is Result.Success -> {
                            pendingRequest = null
                            state.copy(callingFriendId = null, callError = false)
                        }
                        is Result.Error -> state.copy(callingFriendId = null, callError = true)
                    }
                }
            }
        }
    }

    fun retryCallConnection() = callRepository.retryConnection()

    fun retry() { loadFriends() }

    private fun loadFriends() {
        if (loadJob?.isActive == true) return
        loadJob = viewModelScope.launch {
            friendRepository.getFriends().asResult().collect { result ->
                mutableState.value = when (result) {
                    Result.Loading -> HomeUiState.Loading
                    is Result.Success -> HomeUiState.Success(result.data, userRepository.currentUserProfile.value, callConnection = callRepository.callState.value.connection)
                    is Result.Error -> HomeUiState.Error(result.exception)
                }
            }
        }
    }
}
