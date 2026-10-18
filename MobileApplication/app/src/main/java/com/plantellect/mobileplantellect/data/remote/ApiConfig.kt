package com.plantellect.mobileplantellect.data.remote

/** Every server-facing constant lives here so a mount-path change is a one-line edit. */
object ApiConfig {
    // Emulator -> your PC is 10.0.2.2. A physical phone needs the PC's LAN IP instead.
    const val BASE_URL_DEBUG = "http://100.89.207.29:3000/"
    const val BASE_URL_RELEASE = "https://plantellect.tail0c9364.ts.net/"

    // Mount points: must match app.use('/api/...', router) in the server's index.js.
    const val AUTH = "api/auth"
    const val PLANTS = "api/plants"
    const val ML = "api/ml"
    const val DISCOVERIES = "api/discoveries"
    const val BOTANISTS = "api/botanists"

    fun absolute(baseUrl: String, path: String?): String? = when {
        path.isNullOrBlank() -> null
        path.startsWith("http://") || path.startsWith("https://") -> path
        else -> baseUrl.trimEnd('/') + "/" + path.trimStart('/')
    }
}
