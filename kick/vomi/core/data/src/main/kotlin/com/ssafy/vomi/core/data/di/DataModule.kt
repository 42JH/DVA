package com.ssafy.vomi.core.data.di

import com.ssafy.vomi.core.data.repository.AuthRepository
import com.ssafy.vomi.core.data.repository.AuthRepositoryImpl
import com.ssafy.vomi.core.data.repository.FriendRepository
import com.ssafy.vomi.core.data.repository.FriendRepositoryImpl
import com.ssafy.vomi.core.data.auth.SessionAccessTokenProvider
import com.ssafy.vomi.core.network.auth.AccessTokenProvider
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class DataModule {
    @Binds @Singleton internal abstract fun bindFriendRepository(impl: FriendRepositoryImpl): FriendRepository
    @Binds @Singleton abstract fun bindAuthRepository(impl: AuthRepositoryImpl): AuthRepository
    @Binds @Singleton abstract fun bindAccessTokenProvider(impl: SessionAccessTokenProvider): AccessTokenProvider
}
