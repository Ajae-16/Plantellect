package com.plantellect.mobileplantellect.data.repository

import com.plantellect.mobileplantellect.data.logic.ApiCaller
import com.plantellect.mobileplantellect.data.remote.BotanistApi

/**
 * The account itself (email, username, roles) comes from AuthRepository via /me.
 * The only other profile data the server exposes is the PUBLIC botanist profile.
 * There is no route yet to read or edit first/last name.
 */
class ProfileRepository(private val api: BotanistApi, private val caller: ApiCaller) {
    suspend fun botanistProfile(accountId: String) = caller.call { api.profile(accountId) }
}
