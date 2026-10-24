package com.plantellect.mobileplantellect.data.logic

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

enum class ServerStatus {
    /** No check has finished yet (app just started). */
    CHECKING,
    ONLINE,
    /** The phone has no active network at all (airplane mode, Wi-Fi off, ...). */
    NO_NETWORK,
    /** The phone has a network but the Plantellect server did not answer. */
    SERVER_UNREACHABLE
}

/**
 * Keeps one answer to "can this phone reach the Plantellect server right now?" and refreshes it every
 * [CHECK_INTERVAL_MS] (and immediately when the phone's network changes).
 *
 * Scanning reads [status] instead of trying the server and waiting for a timeout, so an offline scan
 * goes straight to the on-device model.
 */
class ServerMonitor(
    private val network: NetworkMonitor,
    baseClient: OkHttpClient,
    private val baseUrl: String,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
) {
    /**
     * Short timeouts, and no app interceptors: a probe must never trigger the "session expired" handler
     * or print into the HTTP log every 10 seconds.
     */
    private val probeClient: OkHttpClient = baseClient.newBuilder()
        .apply {
            interceptors().clear()
            networkInterceptors().clear()
        }
        .cookieJar(CookieJar.NO_COOKIES)
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        .writeTimeout(3, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    private val _status = MutableStateFlow(ServerStatus.CHECKING)
    val status: StateFlow<ServerStatus> = _status.asStateFlow()

    val isReachable: Boolean get() = _status.value == ServerStatus.ONLINE

    private val mutex = Mutex()
    private var loop: Job? = null
    private var watcher: Job? = null

    /** Safe to call repeatedly. Call from onStart so nothing runs while the app is in the background. */
    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            while (isActive) {
                checkNow()
                delay(CHECK_INTERVAL_MS)
            }
        }
        watcher = scope.launch { network.changes.collect { checkNow() } }
    }

    fun stop() {
        loop?.cancel(); loop = null
        watcher?.cancel(); watcher = null
    }

    /** Runs one probe now and returns whether the server answered. Concurrent callers queue up. */
    suspend fun checkNow(): Boolean = mutex.withLock {
        val result = probe()
        _status.value = result
        result == ServerStatus.ONLINE
    }

    /** A real request just failed with a connection error: don't wait for the next probe to find out. */
    fun reportFailure() {
        _status.value = if (network.hasNetwork()) ServerStatus.SERVER_UNREACHABLE else ServerStatus.NO_NETWORK
    }

    private suspend fun probe(): ServerStatus {
        if (!network.hasNetwork()) return ServerStatus.NO_NETWORK
        return withContext(Dispatchers.IO) {
            try {
                val request = Request.Builder().url(baseUrl).head().build()
                probeClient.newCall(request).execute().use { response ->
                    // Any real answer (even 404/401) proves the server is up. A 502-504 comes from a
                    // proxy (e.g. Tailscale) that is up while the Node server behind it is not.
                    if (response.code in 502..504) ServerStatus.SERVER_UNREACHABLE else ServerStatus.ONLINE
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ServerStatus.SERVER_UNREACHABLE
            }
        }
    }

    companion object {
        const val CHECK_INTERVAL_MS = 10_000L
    }
}
