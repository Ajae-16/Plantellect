package com.plantellect.mobileplantellect.data.logic

enum class AccountRole(val wire: String) { USER("user"), BOTANIST("botanist") }

data class RegisterForm(
    val email: String,
    val username: String,
    val password: String,
    val firstName: String = "",
    val lastName: String = "",
    val role: AccountRole = AccountRole.USER,
    val agreeTerms: Boolean = false,
    val agreeInfo: Boolean = false
)

/** Mirrors the checks in routes/auth.js so the user sees the problem before a round trip. */
object AuthValidator {
    fun login(identifier: String, password: String): Map<String, String> = buildMap {
        if (identifier.isBlank()) put("identifier", "Enter your email or username")
        if (password.isEmpty()) put("password", "Enter your password")
    }

    /** Keys: email, username, password, terms, certificate. */
    fun register(form: RegisterForm, hasCertificate: Boolean): Map<String, String> = buildMap {
        if (form.email.isBlank() || !form.email.contains('@')) put("email", "Enter a valid email")
        if (form.username.length < 6) put("username", "Username must be at least 6 characters")
        if (form.password.length < 6) put("password", "Password must be at least 6 characters")
        if (!form.agreeTerms || !form.agreeInfo) put("terms", "You must agree to the terms and the use of your information")
        if (form.role == AccountRole.BOTANIST && !hasCertificate) put("certificate", "A certificate is required for Botanist registration")
    }
}
