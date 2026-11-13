package com.ssafy.vomi.feature.login.impl.model

import com.ssafy.vomi.core.model.auth.LoginError
import com.ssafy.vomi.core.model.auth.TestAccount

data class LoginUiState(
    val loadingAccount: TestAccount? = null,
    val error: LoginError? = null,
) {
    val isLoading: Boolean get() = loadingAccount != null
}
