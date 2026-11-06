package com.plantellect.mobileplantellect.data.repository

import android.util.LruCache
import com.plantellect.mobileplantellect.data.logic.parseProfile
import com.plantellect.mobileplantellect.data.remote.ApiConfig
import com.plantellect.mobileplantellect.data.remote.PlantApi
import com.plantellect.mobileplantellect.data.remote.dto.PlantProfileData
import com.plantellect.mobileplantellect.data.remote.dto.ProfileLoad
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * One plant's full public profile (GET /api/plants/:plantId), parsed tolerantly and cached.
 * 404 means "not published yet".
 */
class PlantProfileRepository(
    private val api: PlantApi,
    private val baseUrl: String
) {
    private val cache = LruCache<String, PlantProfileData>(40)

    /** Photo addresses from the server are paths like /resource/plant-images/display/...; this makes them absolute. */
    fun resolveUrl(path: String?): String? = ApiConfig.absolute(baseUrl, path)

    suspend fun load(plantId: String, force: Boolean = false): ProfileLoad {
        if (!force) cache.get(plantId)?.let { return ProfileLoad.Ready(it) }
        return withContext(Dispatchers.IO) {
            try {
                val response = api.detailRaw(plantId)
                when {
                    response.code() == 404 -> ProfileLoad.NotFound
                    !response.isSuccessful -> ProfileLoad.Failed
                    else -> {
                        val root = Json.parseToJsonElement(response.body()?.string().orEmpty()) as? JsonObject
                        if (root == null) ProfileLoad.Failed
                        else {
                            val data = parseProfile(plantId, root, ::resolveUrl)
                            cache.put(plantId, data)
                            ProfileLoad.Ready(data)
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ProfileLoad.Failed
            }
        }
    }

    /**
     * The first photo of a plant, for a card whose list row carries none
     * (the same fallback home.js uses). Null when the plant has no photo.
     */
    suspend fun heroUrl(plantId: String): String? =
        (load(plantId) as? ProfileLoad.Ready)?.data?.images?.firstOrNull()
}
