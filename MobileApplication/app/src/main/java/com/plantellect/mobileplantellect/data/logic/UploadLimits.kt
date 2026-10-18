package com.plantellect.mobileplantellect.data.logic

/**
 * Mirrors config/settings.js so the app can refuse early with a clear message.
 * The server stays the authority (several values are env-configurable) and answers 400 with its own text.
 */
object UploadLimits {
    /** settings.plantImages.maxDiscoveryFiles */
    const val MAX_DISCOVERY_PHOTOS = 3
    /** settings.plantImages.maxFilesPerRequest (a botanist contribution) */
    const val MAX_CONTRIBUTION_PHOTOS = 20
    /** settings.ml.maxTopK */
    const val MAX_TOP_K = 10
    /** settings.certificates.maxSizeBytes */
    const val MAX_CERTIFICATE_BYTES = 20L * 1024 * 1024

    /**
     * Allowed certificate types -> the file extension to send. The server checks BOTH the mime type
     * and the extension of the uploaded file NAME, so a picked file without an extension is rejected
     * unless the name is rebuilt from the type.
     */
    val CERTIFICATE_TYPES = mapOf(
        "application/pdf" to ".pdf",
        "image/jpeg" to ".jpg",
        "image/png" to ".png"
    )
}
