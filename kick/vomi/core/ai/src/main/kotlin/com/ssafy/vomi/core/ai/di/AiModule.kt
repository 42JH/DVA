package com.ssafy.vomi.core.ai.di

import com.ssafy.vomi.core.ai.GeminiNanoReplyRecommendationClient
import com.ssafy.vomi.core.ai.ReplyRecommendationClient
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
internal abstract class AiModule {
    @Binds @Singleton abstract fun bindReplyRecommendationClient(impl: GeminiNanoReplyRecommendationClient): ReplyRecommendationClient
}
