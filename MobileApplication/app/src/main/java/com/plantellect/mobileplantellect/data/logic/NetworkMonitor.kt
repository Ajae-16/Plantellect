package com.plantellect.mobileplantellect.data.logic

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged

class NetworkMonitor(context: Context) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)

    fun isOnline(): Boolean {
        val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /**
     * Any active network at all. isOnline() also needs Android's "validated" flag, which is false on
     * a LAN-only Wi-Fi or a VPN/Tailscale route even though the API is reachable. Whether the SERVER
     * can actually be reached is decided by [ServerMonitor], not by this.
     */
    fun hasNetwork(): Boolean = cm.activeNetwork != null

    /** For an offline banner in the UI. */
    val onlineFlow: Flow<Boolean> = callbackFlow {
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { trySend(isOnline()) }
            override fun onLost(network: Network) { trySend(isOnline()) }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) { trySend(isOnline()) }
        }
        cm.registerDefaultNetworkCallback(cb)
        trySend(isOnline())
        awaitClose { cm.unregisterNetworkCallback(cb) }
    }.distinctUntilChanged()

    /** Fires whenever the default network appears or disappears (Wi-Fi <-> mobile, airplane mode, ...). */
    val changes: Flow<Unit> = callbackFlow {
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { trySend(Unit) }
            override fun onLost(network: Network) { trySend(Unit) }
        }
        cm.registerDefaultNetworkCallback(cb)
        awaitClose { cm.unregisterNetworkCallback(cb) }
    }
}
