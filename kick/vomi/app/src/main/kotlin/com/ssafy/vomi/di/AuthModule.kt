package com.ssafy.vomi.di

import com.ssafy.vomi.BuildConfig
import com.ssafy.vomi.core.data.auth.AuthDataSource
import com.ssafy.vomi.core.data.auth.MockAuthDataSource
import com.ssafy.vomi.core.network.service.account.AccountClient
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AuthModule {
    @Provides
    @Singleton
    fun provideAuthDataSource(accountClient: AccountClient): AuthDataSource = MockAuthDataSource(
        accountClient = accountClient,
        user1Token = BuildConfig.KICK_TEST_ACCOUNT_1_TOKEN,
        user2Token = BuildConfig.KICK_TEST_ACCOUNT_2_TOKEN,
    )
}
