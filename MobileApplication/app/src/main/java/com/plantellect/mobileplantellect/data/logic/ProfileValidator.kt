package com.plantellect.mobileplantellect.data.logic

/** Same rules as the server's config/profile-rules.js, so the app can refuse before sending anything. */
object ProfileValidator {

    /** Null when fine. A blank bio is allowed: it clears the bio. */
    fun bioProblem(bio: String): String? =
        if (bio.codePointCount(0, bio.length) > UploadLimits.MAX_BIO_CHARS)
            "Bio is too long. The limit is ${UploadLimits.MAX_BIO_CHARS} characters."
        else null

    /** The text to send: trimmed. A blank string is what clears the bio on the server. */
    fun bioToSend(bio: String): String = bio.trim()

    /** Null when the shape is acceptable. Whether the current password is right is the server's call. */
    fun passwordProblem(current: String, new: String, confirm: String? = null): String? = when {
        current.isEmpty() -> "Enter your current password."
        new.isEmpty() -> "Enter a new password."
        new.length < UploadLimits.PASSWORD_MIN_CHARS ->
            "New password must be at least ${UploadLimits.PASSWORD_MIN_CHARS} characters."
        new.toByteArray(Charsets.UTF_8).size > UploadLimits.PASSWORD_MAX_BYTES ->
            "New password is too long (at most ${UploadLimits.PASSWORD_MAX_BYTES} bytes)."
        new == current -> "New password must differ from the current one."
        confirm != null && confirm != new -> "The new passwords do not match."
        else -> null
    }
}
