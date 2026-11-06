package com.plantellect.mobileplantellect.data.repository

import com.plantellect.mobileplantellect.data.local.SessionStore
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.AuthApi
import com.plantellect.mobileplantellect.data.remote.PersistentCookieJar
import com.plantellect.mobileplantellect.data.remote.dto.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withTimeoutOrNull

sealed interface AuthState {
    data object Unknown : AuthState
    data object SignedOut : AuthState
    /** verified=false: showing the cached account (e.g. offline) because /me could not be reached. */
    data class SignedIn(val account: AccountDto, val verified: Boolean) : AuthState
}

class AuthRepository(
    private val api: AuthApi,
    private val caller: ApiCaller,
    private val store: SessionStore,
    private val cookies: PersistentCookieJar
) {
    private val _state = MutableStateFlow<AuthState>(AuthState.Unknown)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    fun hasPermission(permission: String): Boolean =
        (_state.value as? AuthState.SignedIn)?.account?.permissions?.contains(permission) == true

    /** Call once at launch. Cached account first (instant), then confirm with the server. */
    suspend fun restoreSession() {
        val cached = store.loadAccount()
        if (cached == null || !cookies.hasCookies()) { signedOutLocally(); return }
        _state.value = AuthState.SignedIn(cached, verified = false)
        when (val r = caller.call { api.me() }) {
            is ApiResult.Success -> onSignedIn(r.value)
            is ApiResult.Failure -> {
                val e = r.error
                if (e is AppError.Http && e.code == 401) signedOutLocally()
                // Network trouble: stay signed in on the cached account.
            }
        }
    }

    /** identifier is an email if it contains '@', otherwise a username (the server accepts either). */
    suspend fun login(identifier: String, password: String, rememberMe: Boolean): ApiResult<AccountDto> {
        val id = identifier.trim()
        val isEmail = '@' in id
        val request = LoginRequest(
            email = id.takeIf { isEmail },
            username = id.takeIf { !isEmail },
            password = password,
            rememberMe = rememberMe
        )
        return caller.call { api.login(request) }.also { if (it is ApiResult.Success) onSignedIn(it.value) }
    }

    /** A successful register also signs the user in: the server sets the session cookie. */
    suspend fun register(form: RegisterForm): ApiResult<RegisterResponse> {
        val request = RegisterRequest(
            email = form.email.trim(),
            username = form.username.trim(),
            password = form.password,
            firstName = form.firstName.trim().takeIf { it.isNotBlank() },
            lastName = form.lastName.trim().takeIf { it.isNotBlank() },
            agreeTerms = form.agreeTerms,
            agreeInfo = form.agreeInfo
        )
        return caller.call { api.register(request) }
            .also { if (it is ApiResult.Success) onSignedIn(it.value.toAccount()) }
    }

    /** Re-reads roles/permissions from /me. */
    suspend fun refreshProfile(): ApiResult<AccountDto> =
        caller.call { api.me() }.also {
            when (it) {
                is ApiResult.Success -> onSignedIn(it.value)
                is ApiResult.Failure -> (it.error as? AppError.Http)?.takeIf { e -> e.code == 401 }?.let { signedOutLocally() }
            }
        }

    /**
     * Always ends signed out locally, even if the server call fails (e.g. offline). The server call is
     * best-effort and capped at 3 seconds so signing out never hangs on a dead connection.
     */
    suspend fun logout() {
        withTimeoutOrNull(3_000L) { caller.call { api.logout() } }
        signedOutLocally()
    }

    fun onSessionExpired() = signedOutLocally()

    /**
     * After a bio / photo change: copy the new values into the signed-in account (and its cached copy), so every
     * screen that shows the account updates without another /me call. A no-op while signed out.
     */
    fun updateAccount(transform: (AccountDto) -> AccountDto) {
        val current = _state.value as? AuthState.SignedIn ?: return
        val updated = transform(current.account)
        store.saveAccount(updated)
        _state.value = current.copy(account = updated)
    }

    private fun onSignedIn(account: AccountDto) {
        store.saveAccount(account)
        _state.value = AuthState.SignedIn(account, verified = true)
    }

    private fun signedOutLocally() {
        cookies.clear()
        store.clear()
        _state.value = AuthState.SignedOut
    }
}
