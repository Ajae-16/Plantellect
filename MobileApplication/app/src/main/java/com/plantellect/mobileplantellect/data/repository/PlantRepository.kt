package com.plantellect.mobileplantellect.data.repository

import com.plantellect.mobileplantellect.data.logic.ApiCaller
import com.plantellect.mobileplantellect.data.logic.ApiResult
import com.plantellect.mobileplantellect.data.logic.map
import com.plantellect.mobileplantellect.data.remote.ApiConfig
import com.plantellect.mobileplantellect.data.remote.PlantApi
import com.plantellect.mobileplantellect.data.remote.dto.*

class PlantRepository(
    private val api: PlantApi,
    private val caller: ApiCaller,
    private val baseUrl: String
) {
    suspend fun types(): ApiResult<List<PlantTypeDto>> = caller.call { api.types() }.map { it.types }

    /** [typeName] is PlantTypeDto.typeName (e.g. "herb"), NOT typeId. */
    suspend fun list(search: String?, typeName: String?, page: Int, pageSize: Int = 20): ApiResult<PlantPageDto> =
        caller.call { api.list(search?.trim()?.takeIf { it.isNotEmpty() }, typeName, page, pageSize) }

    suspend fun detail(plantId: String): ApiResult<PlantDetailDto> = caller.call { api.detail(plantId) }

    /** Full URL for an approved plant photo (public, cacheable). */
    fun imageUrl(plantId: String, imageId: String): String =
        "${baseUrl.trimEnd('/')}/${ApiConfig.PLANTS}/$plantId/images/$imageId"

    /** Resolves the relative imageUrl the scan endpoint returns. */
    fun absoluteUrl(path: String?): String? = ApiConfig.absolute(baseUrl, path)

    /** Primary photo of a list item (already a relative path from the server). */
    fun heroUrl(p: PlantSummaryDto): String? = absoluteUrl(p.imageUrl)
}
