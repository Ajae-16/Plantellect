package com.plantellect.mobileplantellect.data.repository

import com.plantellect.mobileplantellect.data.logic.ApiCaller
import com.plantellect.mobileplantellect.data.logic.ApiResult
import com.plantellect.mobileplantellect.data.remote.AboutApi
import com.plantellect.mobileplantellect.data.remote.dto.AboutDto

class AboutRepository(private val api: AboutApi, private val caller: ApiCaller) {
    suspend fun about(): ApiResult<AboutDto> = caller.call { api.about() }
}
