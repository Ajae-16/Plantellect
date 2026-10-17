package com.plantellect.mobileplantellect.viewmodel

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.repository.AuthRepository
import com.plantellect.mobileplantellect.data.repository.AuthState
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

data class AuthUiState(
    val busy: Boolean = false,
    /** Server / network message for a snackbar or banner. */
    val error: String? = null,
    /** Per-field messages. Keys: identifier, email, username, password, terms, certificate. */
    val fieldErrors: Map<String, String> = emptyMap(),
    /** Set after a botanist sign-up so the UI can say "awaiting review" or "approved". */
    val notice: String? = null
)

class AuthViewModel(
    private val repo: AuthRepository,
    sessionExpired: Flow<Unit>
) : ViewModel() {

    val authState: StateFlow<AuthState> = repo.state

    private val _ui = MutableStateFlow(AuthUiState())
    val ui: StateFlow<AuthUiState> = _ui.asStateFlow()

    init {
        viewModelScope.launch { repo.restoreSession() }
        viewModelScope.launch { sessionExpired.collect { repo.onSessionExpired() } }
    }

    fun login(identifier: String, password: String, rememberMe: Boolean) {
        val problems = AuthValidator.login(identifier, password)
        if (problems.isNotEmpty()) { _ui.value = AuthUiState(fieldErrors = problems); return }
        launchBusy {
            when (val r = repo.login(identifier, password, rememberMe)) {
                is ApiResult.Success -> AuthUiState()
                is ApiResult.Failure -> AuthUiState(error = r.error.userMessage())
            }
        }
    }

    fun register(form: RegisterForm, certificate: Uri?) {
        val problems = AuthValidator.register(form, hasCertificate = certificate != null)
        if (problems.isNotEmpty()) { _ui.value = AuthUiState(fieldErrors = problems); return }
        launchBusy {
            when (val r = repo.register(form, certificate)) {
                is ApiResult.Success -> AuthUiState(
                    notice = when {
                        r.value.autoApproved -> "Botanist role approved."
                        r.value.pending -> "Account created. Your botanist request is awaiting review."
                        else -> null
                    }
                )
                is ApiResult.Failure -> AuthUiState(error = r.error.userMessage())
            }
        }
    }

    fun refreshProfile() { viewModelScope.launch { repo.refreshProfile() } }

    fun logout() { viewModelScope.launch { repo.logout(); _ui.value = AuthUiState() } }

    fun consumeMessages() { _ui.update { it.copy(error = null, notice = null, fieldErrors = emptyMap()) } }

    private fun launchBusy(block: suspend () -> AuthUiState) {
        _ui.value = AuthUiState(busy = true)
        viewModelScope.launch { _ui.value = block() }
    }
}
