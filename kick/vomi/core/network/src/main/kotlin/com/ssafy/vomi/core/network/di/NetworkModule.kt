package com.ssafy.vomi.core.network.di

import com.ssafy.vomi.core.network.BuildConfig
import com.ssafy.vomi.core.network.NetworkConfig
import com.ssafy.vomi.core.network.auth.AccessTokenInterceptor
import com.ssafy.vomi.core.network.service.account.AccountService
import com.ssafy.vomi.core.network.service.call.CallEvents
import com.ssafy.vomi.core.network.service.call.CallEventsClient
import com.ssafy.vomi.core.network.service.call.CallService
import com.ssafy.vomi.core.network.service.call.CallEventService
import com.ssafy.vomi.core.network.service.device.DeviceService
import com.ssafy.vomi.core.network.service.friend.FriendService
import com.ssafy.vomi.core.network.service.health.HealthService
import com.ssafy.vomi.core.network.service.voice.VoiceService
import com.ssafy.vomi.core.network.service.voice.VoiceSpeechService
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import java.util.concurrent.TimeUnit
import javax.inject.Singleton
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {
    @Provides @Singleton
    fun provideJson(): Json = Json { ignoreUnknownKeys = true }

    @Provides @Singleton
    fun provideHttpLoggingInterceptor(): HttpLoggingInterceptor = createHttpLoggingInterceptor()

    @Provides @Singleton
    fun provideOkHttpClient(
        accessTokenInterceptor: AccessTokenInterceptor,
        loggingInterceptor: HttpLoggingInterceptor,
    ): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(accessTokenInterceptor)
        .addInterceptor(loggingInterceptor)
        .connectTimeout(NetworkConfig.TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(NetworkConfig.TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(NetworkConfig.TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .callTimeout(NetworkConfig.TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    @Provides @Singleton
    fun provideRetrofit(json: Json, client: OkHttpClient): Retrofit = Retrofit.Builder()
        .baseUrl(NetworkConfig.BASE_URL)
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    @Provides @Singleton @StreamingNetwork
    fun provideStreamingOkHttpClient(client: OkHttpClient): OkHttpClient = client.newBuilder()
        .callTimeout(0, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build()

    @Provides @Singleton @StreamingNetwork
    fun provideStreamingRetrofit(retrofit: Retrofit, @StreamingNetwork client: OkHttpClient): Retrofit =
        retrofit.newBuilder().client(client).build()

    @Provides @Singleton
    fun provideFriendService(retrofit: Retrofit): FriendService = retrofit.create(FriendService::class.java)

    @Provides @Singleton
    fun provideVoiceService(retrofit: Retrofit): VoiceService = retrofit.create(VoiceService::class.java)

    @Provides @Singleton
    fun provideVoiceSpeechService(@StreamingNetwork retrofit: Retrofit): VoiceSpeechService =
        retrofit.create(VoiceSpeechService::class.java)

    @Provides @Singleton
    fun provideCallEvents(client: CallEventsClient): CallEvents = client

    @Provides @Singleton
    fun provideCallService(retrofit: Retrofit): CallService = retrofit.create(CallService::class.java)

    @Provides @Singleton
    fun provideCallEventService(@StreamingNetwork retrofit: Retrofit): CallEventService =
        retrofit.create(CallEventService::class.java)

    @Provides @Singleton
    fun provideDeviceService(retrofit: Retrofit): DeviceService = retrofit.create(DeviceService::class.java)

    @Provides @Singleton
    fun provideHealthService(retrofit: Retrofit): HealthService = retrofit.create(HealthService::class.java)

    @Provides @Singleton
    fun provideAccountService(retrofit: Retrofit): AccountService = retrofit.create(AccountService::class.java)
}

internal fun createHttpLoggingInterceptor(
    logger: HttpLoggingInterceptor.Logger = HttpLoggingInterceptor.Logger.DEFAULT,
): HttpLoggingInterceptor = HttpLoggingInterceptor(logger).apply {
    level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BASIC else HttpLoggingInterceptor.Level.NONE
    redactHeader("Authorization")
}
