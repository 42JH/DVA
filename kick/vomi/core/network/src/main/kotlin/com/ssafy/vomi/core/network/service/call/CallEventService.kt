package com.ssafy.vomi.core.network.service.call

import okhttp3.ResponseBody
import retrofit2.Call
import retrofit2.http.GET
import retrofit2.http.Headers
import retrofit2.http.Streaming

interface CallEventService {
    @Streaming
    @Headers("Accept: text/event-stream")
    @GET("api/calls/events")
    fun getEvents(): Call<ResponseBody>
}
