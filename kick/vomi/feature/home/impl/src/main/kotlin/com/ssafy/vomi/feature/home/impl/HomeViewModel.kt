package com.ssafy.vomi.feature.home.impl

import androidx.lifecycle.ViewModel
import com.ssafy.vomi.core.data.repository.AuthRepository
import com.ssafy.vomi.feature.home.impl.model.HomeUiState
import com.ssafy.vomi.feature.home.impl.model.sampleFriends
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

@HiltViewModel
internal class HomeViewModel @Inject constructor(private val auth: AuthRepository) : ViewModel() {
    private val _uiState = MutableStateFlow<HomeUiState>(HomeUiState.Success(sampleFriends, auth.currentUser.value))
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()

    fun retry() {
        // Replace the sample source with the repository when the friend API is ready.
        _uiState.value = HomeUiState.Success(sampleFriends, auth.currentUser.value)
    }
}
