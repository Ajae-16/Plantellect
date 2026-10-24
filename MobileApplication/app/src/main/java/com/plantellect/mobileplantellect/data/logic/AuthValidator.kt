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

    /** Live checklist for the sign-up password field; the screen and [register] share it. */
    data class PasswordChecks(val length: Boolean, val lowercase: Boolean, val uppercase: Boolean, val number: Boolean) {
        val allMet get() = length && lowercase && uppercase && number
    }

    fun passwordChecks(password: String) = PasswordChecks(
        length = password.length >= 6,
        lowercase = password.any { it in 'a'..'z' },
        uppercase = password.any { it in 'A'..'Z' },
        number = password.any { it in '0'..'9' }
    )

    /**
     * Keys: firstName, lastName, email, username, password, confirm, terms, certificate.
     * The name, password-strength and confirm rules mirror public/javascript/auth-script.js (the server
     * only enforces the length rules, but the website asks for more, so the app does too).
     */
    fun register(form: RegisterForm, hasCertificate: Boolean, confirmPassword: String = form.password): Map<String, String> = buildMap {
        if (form.firstName.isBlank()) put("firstName", "Enter your first name")
        if (form.lastName.isBlank()) put("lastName", "Enter your last name")
        if (form.email.isBlank() || !form.email.contains('@')) put("email", "Enter a valid email")
        if (form.username.trim().length < 6) put("username", "Username must be at least 6 characters")
        val checks = passwordChecks(form.password)
        when {
            form.password.length < 6 -> put("password", "Password must be at least 6 characters")
            !checks.allMet -> put("password", "Password needs a lowercase letter, an uppercase letter and a number")
        }
        if (confirmPassword != form.password) put("confirm", "Passwords do not match")
        if (!form.agreeTerms || !form.agreeInfo) put("terms", "You must agree to the terms and the use of your information")
        if (form.role == AccountRole.BOTANIST && !hasCertificate) put("certificate", "A certificate is required for Botanist registration")
    }
}
