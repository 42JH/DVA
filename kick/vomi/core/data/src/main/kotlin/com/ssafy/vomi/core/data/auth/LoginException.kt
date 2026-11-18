package com.ssafy.vomi.core.data.auth

import com.ssafy.vomi.core.model.auth.LoginError

class LoginException(val reason: LoginError) : Exception(reason.name)