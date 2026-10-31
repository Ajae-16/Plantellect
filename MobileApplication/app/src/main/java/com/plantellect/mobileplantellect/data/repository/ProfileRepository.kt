package com.plantellect.mobileplantellect.data.repository

import com.plantellect.mobileplantellect.data.logic.ApiCaller
import com.plantellect.mobileplantellect.data.remote.BotanistApi
import com.plantellect.mobileplantellect.data.remote.DiscoveryApi

/**
 * The account itself (email, username, roles) comes from AuthRepository via /me.
 * Besides that, the profile shows the signed-in user's own discovery reports,
 * the same data the web profile page loads from /api/discoveries/mine.
 */
class ProfileRepository(
    private val api: BotanistApi,
    private val discoveries: DiscoveryApi,
    private val caller: ApiCaller
) {
    suspend fun botanistProfile(accountId: String) = caller.call { api.profile(accountId) }

    suspend fun myReports(page: Int, pageSize: Int = REPORTS_PAGE_SIZE) =
        caller.call { discoveries.mine(page, pageSize) }

    suspend fun withdraw(requestId: String) = caller.call { discoveries.cancel(requestId) }

    companion object {
        const val REPORTS_PAGE_SIZE = 10
    }
}