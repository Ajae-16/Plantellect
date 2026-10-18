package com.plantellect.mobileplantellect.data.repository

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import com.plantellect.mobileplantellect.data.local.SessionStore
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.AuthApi
import com.plantellect.mobileplantellect.data.remote.PersistentCookieJar
import com.plantellect.mobileplantellect.data.remote.dto.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

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
    private val cookies: PersistentCookieJar,
    private val resolver: ContentResolver
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
    suspend fun register(form: RegisterForm, certificate: Uri?): ApiResult<RegisterResponse> {
        fun text(v: String): RequestBody = v.toRequestBody("text/plain".toMediaType())
        val fields = buildMap<String, RequestBody> {
            put("email", text(form.email.trim()))
            put("username", text(form.username.trim()))
            put("password", text(form.password))
            put("role", text(form.role.wire))
            put("agreeTerms", text(form.agreeTerms.toString()))
            put("agreeInfo", text(form.agreeInfo.toString()))
            if (form.firstName.isNotBlank()) put("firstName", text(form.firstName.trim()))
            if (form.lastName.isNotBlank()) put("lastName", text(form.lastName.trim()))
        }
        // The server discards a certificate sent with the plain 'user' role, so don't upload one.
        val part = if (form.role == AccountRole.BOTANIST) {
            certificate?.let {
                try {
                    readCertificate(it)
                } catch (e: IllegalArgumentException) {
                    return ApiResult.Failure(AppError.Http(400, e.message ?: "Could not use that certificate file."))
                }
            }
        } else null
        return caller.call { api.register(fields, part) }
            .also { if (it is ApiResult.Success) onSignedIn(it.value.toAccount()) }
    }

    /** Re-reads roles/permissions, e.g. after an admin approves a botanist request. */
    suspend fun refreshProfile(): ApiResult<AccountDto> =
        caller.call { api.me() }.also {
            when (it) {
                is ApiResult.Success -> onSignedIn(it.value)
                is ApiResult.Failure -> (it.error as? AppError.Http)?.takeIf { e -> e.code == 401 }?.let { signedOutLocally() }
            }
        }

    /** Always ends signed out locally, even if the server call fails (e.g. offline). */
    suspend fun logout() {
        caller.call { api.logout() }
        signedOutLocally()
    }

    fun onSessionExpired() = signedOutLocally()

    private fun onSignedIn(account: AccountDto) {
        store.saveAccount(account)
        _state.value = AuthState.SignedIn(account, verified = true)
    }

    private fun signedOutLocally() {
        cookies.clear()
        store.clear()
        _state.value = AuthState.SignedOut
    }

    /** Throws IllegalArgumentException with a user-facing message when the file can't be accepted. */
    private suspend fun readCertificate(uri: Uri): MultipartBody.Part = withContext(Dispatchers.IO) {
        val mime = resolver.getType(uri)
        val ext = UploadLimits.CERTIFICATE_TYPES[mime]
            ?: throw IllegalArgumentException("The certificate must be a PDF, JPG or PNG file.")

        var displayName: String? = null
        var size: Long? = null
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                displayName = c.getString(0)
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        // Check the size BEFORE reading the whole file into memory.
        if ((size ?: 0L) > UploadLimits.MAX_CERTIFICATE_BYTES) {
            throw IllegalArgumentException("The certificate is too large (maximum 20 MB).")
        }

        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
            ?: throw IllegalArgumentException("Could not read the certificate file.")
        if (bytes.size > UploadLimits.MAX_CERTIFICATE_BYTES) {
            throw IllegalArgumentException("The certificate is too large (maximum 20 MB).")
        }

        // The server validates the extension of the file NAME as well as the mime type, so rebuild
        // the name from the detected type instead of trusting whatever the picker returned.
        val base = displayName?.substringBeforeLast('.', displayName!!)?.takeIf { it.isNotBlank() } ?: "certificate"
        MultipartBody.Part.createFormData("certificate", base + ext, bytes.toRequestBody(mime!!.toMediaType()))
    }
}
