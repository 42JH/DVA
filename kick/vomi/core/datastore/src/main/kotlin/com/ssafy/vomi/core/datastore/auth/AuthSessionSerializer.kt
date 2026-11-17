package com.ssafy.vomi.core.datastore.auth

import androidx.datastore.core.CorruptionException
import androidx.datastore.core.Serializer
import com.google.protobuf.InvalidProtocolBufferException
import com.ssafy.vomi.core.datastore.AuthSessionPreferences
import java.io.InputStream
import java.io.OutputStream
import javax.inject.Inject

class AuthSessionSerializer @Inject constructor() : Serializer<AuthSessionPreferences> {
    override val defaultValue: AuthSessionPreferences = AuthSessionPreferences.getDefaultInstance()
    override suspend fun readFrom(input: InputStream): AuthSessionPreferences = try {
        AuthSessionPreferences.parseFrom(input)
    } catch (error: InvalidProtocolBufferException) {
        throw CorruptionException("Cannot read authentication session", error)
    }
    override suspend fun writeTo(t: AuthSessionPreferences, output: OutputStream) { t.writeTo(output) }
}
