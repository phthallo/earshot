package com.venuemap.locator

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

data class TrackerState(
    val person: Person? = null,
    val tracking: Boolean = false,
    val zoneName: String? = null,
    val confidence: Double? = null,
    val lastScanAt: Long = 0L,
    val scanCount: Int = 0,
    val connectedRssi: Int? = null,
    val throttled: Boolean = false,
    val locationOff: Boolean = false,
    val error: String? = null,
)

object Tracker {
    val state = MutableStateFlow(TrackerState())
    fun update(transform: (TrackerState) -> TrackerState) = state.update(transform)
}

class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("locator", Context.MODE_PRIVATE)

    var baseUrl: String
        get() = sp.getString("baseUrl", null) ?: "http://10.0.0.2:8080"
        set(value) { sp.edit().putString("baseUrl", value).apply() }

    var pairCode: String?
        get() = sp.getString("pairCode", null)
        set(value) { sp.edit().putString("pairCode", value).apply() }

    var person: Person?
        get() = sp.getString("person", null)?.let { Person.fromJson(it) }
        set(value) { sp.edit().putString("person", value?.toJson()).apply() }

    fun signOut() {
        sp.edit().remove("pairCode").remove("person").apply()
    }
}

data class ScanOutcome(val scans: List<Scan>, val fresh: Boolean)

class WifiScanner(context: Context) {
    private val app = context.applicationContext
    private val wifi = app.getSystemService(WifiManager::class.java)
    private var lastNewest = 0L

    // Throttled scans return the cached list with unchanged timestamps, so a
    // repeated newest timestamp is how we detect throttling.
    @Suppress("DEPRECATION")
    suspend fun scan(): ScanOutcome {
        if (wifi.startScan()) awaitResults()
        val results = try { wifi.scanResults } catch (e: SecurityException) { emptyList() }
        val newest = results.maxOfOrNull { it.timestamp } ?: 0L
        val fresh = results.isNotEmpty() && newest != lastNewest
        lastNewest = newest
        return ScanOutcome(results.filter { it.BSSID != null }.map { Scan(it.BSSID, it.level) }, fresh)
    }

    @Suppress("DEPRECATION")
    fun connectedRssi(): Int? {
        val info = wifi.connectionInfo ?: return null
        return if (info.networkId == -1) null else info.rssi
    }

    private suspend fun awaitResults() {
        withTimeoutOrNull(15_000) {
            suspendCancellableCoroutine<Unit> { cont ->
                val receiver = object : BroadcastReceiver() {
                    override fun onReceive(c: Context, intent: Intent) {
                        runCatching { app.unregisterReceiver(this) }
                        if (cont.isActive) cont.resume(Unit)
                    }
                }
                ContextCompat.registerReceiver(
                    app, receiver,
                    IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION),
                    ContextCompat.RECEIVER_EXPORTED,
                )
                cont.invokeOnCancellation { runCatching { app.unregisterReceiver(receiver) } }
            }
        }
    }

    companion object {
        fun requiredPermissions(): List<String> = buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (Build.VERSION.SDK_INT >= 33) {
                add(Manifest.permission.NEARBY_WIFI_DEVICES)
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        fun hasPermissions(context: Context): Boolean {
            fun granted(p: String) =
                ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED
            return granted(Manifest.permission.ACCESS_FINE_LOCATION) &&
                (Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.NEARBY_WIFI_DEVICES))
        }

        fun locationOn(context: Context): Boolean =
            context.getSystemService(LocationManager::class.java).isLocationEnabled
    }
}
