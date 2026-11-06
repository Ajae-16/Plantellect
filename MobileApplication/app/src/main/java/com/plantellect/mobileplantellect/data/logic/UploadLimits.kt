package com.plantellect.mobileplantellect.data.logic

/**
 * Mirrors config/settings.js so the app can refuse early with a clear message.
 * The server stays the authority (several values are env-configurable) and answers 400 with its own text.
 */
object UploadLimits {
    /** settings.plantImages.maxDiscoveryFiles */
    const val MAX_DISCOVERY_PHOTOS = 3
    /** settings.plantImages.maxFilesPerRequest (a contribution) */
    const val MAX_CONTRIBUTION_PHOTOS = 20
    /** settings.ml.maxTopK */
    const val MAX_TOP_K = 10
    /** settings.userImages.maxSizeBytes: a profile photo is at most 10 MB. */
    const val MAX_PROFILE_PHOTO_BYTES = 10 * 1024 * 1024
    /** settings.userImages.bioMaxLength, counted in characters (an emoji is one). */
    const val MAX_BIO_CHARS = 500
    /** config/profile-rules.js */
    const val PASSWORD_MIN_CHARS = 6
    const val PASSWORD_MAX_BYTES = 72
}
