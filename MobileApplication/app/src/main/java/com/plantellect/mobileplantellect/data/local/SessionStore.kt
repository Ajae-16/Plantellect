package com.plantellect.mobileplantellect.data.local

import android.content.Context
import com.plantellect.mobileplantellect.data.remote.dto.AccountDto
import kotlinx.serialization.json.Json

/** Last known account, so the app can open signed-in (and offline) before /me answers. */
class SessionStore(context: Context, private val json: Json) {
    private val prefs = context.getSharedPreferences("plantellect_session", Context.MODE_PRIVATE)

    fun loadAccount(): AccountDto? = prefs.getString(KEY, null)?.let {
        runCatching { json.decodeFromString<AccountDto>(it) }.getOrNull()
    }

    fun saveAccount(account: AccountDto) {
        prefs.edit().putString(KEY, json.encodeToString(AccountDto.serializer(), account)).apply()
    }

    fun clear() = prefs.edit().clear().apply()

    private companion object { const val KEY = "account" }
}
