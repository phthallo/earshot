package com.venuemap.locator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.SystemClock
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ScanService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var job: Job? = null
    private lateinit var scanner: WifiScanner
    private lateinit var prefs: Prefs
    private var zoneNames: Map<String, String> = emptyMap()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        scanner = WifiScanner(this)
        prefs = Prefs(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        if (job == null) {
            Tracker.update { it.copy(tracking = true, error = null) }
            job = scope.launch {
                launch { rssiLoop() }
                scanLoop()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        Tracker.update { it.copy(tracking = false, connectedRssi = null) }
        super.onDestroy()
    }

    private suspend fun scanLoop() {
        zoneNames = runCatching { withContext(Dispatchers.IO) { Api.zones(prefs.baseUrl) } }
            .getOrDefault(emptyList()).associate { it.zoneId to it.name }
        while (true) {
            val startedAt = SystemClock.elapsedRealtime()
            val outcome = scanner.scan()
            if (outcome.scans.isEmpty()) {
                Tracker.update { it.copy(locationOff = !WifiScanner.locationOn(this@ScanService)) }
            } else {
                Tracker.update { it.copy(locationOff = false, throttled = !outcome.fresh) }
                if (outcome.fresh) locate(outcome.scans)
            }
            delay((SCAN_PERIOD_MS - (SystemClock.elapsedRealtime() - startedAt)).coerceAtLeast(1_000))
        }
    }

    private suspend fun locate(scans: List<Scan>) {
        val code = prefs.pairCode ?: return
        Tracker.update { it.copy(lastScanAt = System.currentTimeMillis(), scanCount = it.scanCount + 1) }
        try {
            val loc = withContext(Dispatchers.IO) { Api.locate(prefs.baseUrl, code, scans) }
            Tracker.update {
                it.copy(zoneName = zoneNames[loc.zoneId] ?: loc.zoneId, confidence = loc.confidence, error = null)
            }
        } catch (e: Exception) {
            Tracker.update { it.copy(error = e.message ?: "Request failed") }
        }
    }

    private suspend fun rssiLoop() {
        while (true) {
            Tracker.update { it.copy(connectedRssi = scanner.connectedRssi()) }
            delay(1_000)
        }
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Tracking", NotificationManager.IMPORTANCE_LOW)
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("Tracking your zone over wifi")
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "tracking"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP = "com.venuemap.locator.STOP"
        private const val SCAN_PERIOD_MS = 10_000L

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, ScanService::class.java))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, ScanService::class.java).setAction(ACTION_STOP))
        }
    }
}
