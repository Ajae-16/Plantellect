package com.plantellect.mobileplantellect.data.remote

import com.plantellect.mobileplantellect.data.remote.dto.AboutDto
import retrofit2.Response
import retrofit2.http.GET

interface AboutApi {
    /** The About text of the Home page. Public: no sign-in needed. */
    @GET(ApiConfig.ABOUT)
    suspend fun about(): Response<AboutDto>
}
