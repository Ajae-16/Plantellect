package com.plantellect.mobileplantellect.data.remote

import android.content.Context
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import java.util.concurrent.ConcurrentHashMap

/**
 * The server authenticates with an express-session cookie (connect.sid), not a token,
 * so the cookie IS the login. This jar keeps it across app restarts.
 *
 * Session cookies (no Max-Age, i.e. "remember me" off) are persisted too: Android has no
 * "browser closed" moment, and AuthRepository.restoreSession() validates against /me on
 * launch anyway. The server's own session TTL is what really ends a login.
 */
class PersistentCookieJar(context: Context) : CookieJar {
    private val prefs = context.getSharedPreferences("plantellect_cookies", Context.MODE_PRIVATE)
    private val store = ConcurrentHashMap<String, Cookie>()

    init {
        prefs.all.forEach { (key, value) ->
            (value as? String)?.let(::decode)?.let { store[key] = it }
        }
        purgeExpired()
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val edit = prefs.edit()
        for (cookie in cookies) {
            val key = keyOf(cookie)
            if (cookie.expiresAt <= System.currentTimeMillis()) {
                // Express clearCookie() on logout arrives as an already-expired cookie.
                store.remove(key); edit.remove(key)
            } else {
                store[key] = cookie; edit.putString(key, encode(cookie))
            }
        }
        edit.apply()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        purgeExpired()
        return store.values.filter { it.matches(url) }
    }

    fun hasCookies(): Boolean { purgeExpired(); return store.isNotEmpty() }

    fun clear() {
        store.clear()
        prefs.edit().clear().apply()
    }

    private fun purgeExpired() {
        val now = System.currentTimeMillis()
        val dead = store.filterValues { it.expiresAt <= now }.keys
        if (dead.isNotEmpty()) {
            dead.forEach { store.remove(it) }
            prefs.edit().apply { dead.forEach { remove(it) } }.apply()
        }
    }

    private fun keyOf(c: Cookie) = "${c.name}|${c.domain}|${c.path}"

    private fun encode(c: Cookie) = listOf(
        c.name, c.value, c.expiresAt, c.domain, c.path, c.secure, c.httpOnly, c.hostOnly, c.persistent
    ).joinToString(SEP)

    private fun decode(raw: String): Cookie? = try {
        val p = raw.split(SEP)
        Cookie.Builder().name(p[0]).value(p[1]).path(p[4]).apply {
            if (p[7].toBoolean()) hostOnlyDomain(p[3]) else domain(p[3])
            if (p[8].toBoolean()) expiresAt(p[2].toLong())
            if (p[5].toBoolean()) secure()
            if (p[6].toBoolean()) httpOnly()
        }.build()
    } catch (e: Exception) { null }

    private companion object { const val SEP = "\u0001" }
}
