package com.ssafy.vomi.core.network.service.call

import com.ssafy.vomi.core.network.model.call.CallResponse
import com.ssafy.vomi.core.network.model.call.CallStateResponse
import com.ssafy.vomi.core.network.model.call.CreateCallRequest
import com.ssafy.vomi.core.network.model.call.JoinCallResponse
import com.ssafy.vomi.core.network.model.call.UpdateCallRequest
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path

interface CallService {
    @POST("api/calls")
    suspend fun createCall(@Body request: CreateCallRequest): CallResponse

    @GET("api/calls/active")
    suspend fun getActiveCall(): CallStateResponse

    @GET("api/calls/{id}")
    suspend fun getCall(@Path("id") callId: String): CallResponse

    @PATCH("api/calls/{id}")
    suspend fun updateCall(@Path("id") callId: String, @Body request: UpdateCallRequest)

    @POST("api/calls/{id}/join")
    suspend fun joinCall(@Path("id") callId: String): JoinCallResponse
}
