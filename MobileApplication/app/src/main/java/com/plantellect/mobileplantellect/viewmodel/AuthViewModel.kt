package com.plantellect.mobileplantellect.viewmodel

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
    /** Per-field messages. Keys: identifier, firstName, lastName, email, username, password, confirm, terms. */
    val fieldErrors: Map<String, String> = emptyMap(),
    /** One-off info message for the UI. Nothing sets it now that sign-up has no review step. */
    val notice: String? = null,
    /** True while the sign-out request is running (drives the confirmation dialog's spinner). */
    val signingOut: Boolean = false
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

    fun register(form: RegisterForm, confirmPassword: String = form.password) {
        val problems = AuthValidator.register(form, confirmPassword = confirmPassword)
        if (problems.isNotEmpty()) { _ui.value = AuthUiState(fieldErrors = problems); return }
        launchBusy {
            when (val r = repo.register(form)) {
                is ApiResult.Success -> AuthUiState()
                is ApiResult.Failure -> AuthUiState(error = r.error.userMessage())
            }
        }
    }

    fun refreshProfile() { viewModelScope.launch { repo.refreshProfile() } }

    fun logout() {
        if (_ui.value.signingOut) return
        _ui.value = AuthUiState(signingOut = true)
        viewModelScope.launch {
            repo.logout()
            _ui.value = AuthUiState()
        }
    }

    fun consumeMessages() { _ui.update { it.copy(error = null, notice = null, fieldErrors = emptyMap()) } }

    private fun launchBusy(block: suspend () -> AuthUiState) {
        _ui.value = AuthUiState(busy = true)
        viewModelScope.launch { _ui.value = block() }
    }
}
