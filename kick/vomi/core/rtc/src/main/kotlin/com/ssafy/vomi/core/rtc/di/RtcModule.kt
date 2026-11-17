package com.ssafy.vomi.core.rtc.di

import com.ssafy.vomi.core.rtc.LiveKitRtcClient
import com.ssafy.vomi.core.rtc.RtcClient
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class RtcModule {
    @Binds
    @Singleton
    internal abstract fun bindRtcClient(implementation: LiveKitRtcClient): RtcClient
}
