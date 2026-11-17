package com.ssafy.vomi.core.datastore.di

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.core.DataStoreFactory
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.dataStoreFile
import com.ssafy.vomi.core.common.network.Dispatcher
import com.ssafy.vomi.core.common.network.VomiDispatcher
import com.ssafy.vomi.core.common.network.di.ApplicationScope
import com.ssafy.vomi.core.datastore.AuthSessionPreferences
import com.ssafy.vomi.core.datastore.auth.AuthSessionSerializer
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope

@Module
@InstallIn(SingletonComponent::class)
object DataStoreModule {
    @Provides @Singleton
    fun provideAuthSessionDataStore(
        @ApplicationContext context: Context,
        @Dispatcher(VomiDispatcher.IO) io: CoroutineDispatcher,
        @ApplicationScope scope: CoroutineScope,
        serializer: AuthSessionSerializer,
    ): DataStore<AuthSessionPreferences> = DataStoreFactory.create(
        serializer = serializer,
        corruptionHandler = ReplaceFileCorruptionHandler { serializer.defaultValue },
        scope = CoroutineScope(scope.coroutineContext + io),
    ) { context.dataStoreFile("auth_session.pb") }
}
