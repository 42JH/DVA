package com.ssafy.vomi.di

import com.ssafy.vomi.BuildConfig
import com.ssafy.vomi.core.data.auth.TestAccountCredentials
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object TestAuthModule {
    @Provides @Singleton fun credentials() = TestAccountCredentials(
        BuildConfig.KICK_TEST_ACCOUNT_1_TOKEN, BuildConfig.KICK_TEST_ACCOUNT_2_TOKEN,
    )
}
