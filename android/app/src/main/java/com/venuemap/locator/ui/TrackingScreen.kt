package com.venuemap.locator.ui

import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.venuemap.locator.Prefs
import com.venuemap.locator.ScanService
import com.venuemap.locator.Tracker
import com.venuemap.locator.TrackerState
import com.venuemap.locator.WifiScanner
import com.venuemap.locator.openSettings
import kotlinx.coroutines.delay

@Composable
fun TrackingScreen(prefs: Prefs, state: TrackerState, onLearn: () -> Unit, onSignOut: () -> Unit) {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(WifiScanner.hasPermissions(context)) }
    var startAfterGrant by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        granted = WifiScanner.hasPermissions(context)
        if (granted && startAfterGrant) {
            Tracker.update { it.copy(tracking = true) }
            ScanService.start(context)
        }
        startAfterGrant = false
    }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            now = System.currentTimeMillis()
        }
    }

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Spacer(Modifier.size(20.dp).clip(CircleShape).background(parseColor(state.person?.color)))
            Text(state.person?.displayName ?: "Unknown", style = MaterialTheme.typography.headlineSmall)
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(state.zoneName ?: "No zone yet", style = MaterialTheme.typography.headlineMedium)
                state.confidence?.let { Text("Confidence ${(it * 100).toInt()}%") }
                Text(
                    if (state.lastScanAt == 0L) "No scans yet"
                    else "Last scan ${(now - state.lastScanAt).coerceAtLeast(0) / 1000} s ago, ${state.scanCount} total",
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    "Connected AP " + (state.connectedRssi?.let { "$it dBm" } ?: "none"),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(if (state.tracking) "Tracking on" else "Tracking off", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            Switch(
                checked = state.tracking,
                onCheckedChange = { on ->
                    if (!on) {
                        ScanService.stop(context)
                    } else if (granted) {
                        Tracker.update { it.copy(tracking = true) }
                        ScanService.start(context)
                    } else {
                        startAfterGrant = true
                        launcher.launch(WifiScanner.requiredPermissions().toTypedArray())
                    }
                },
            )
        }

        if (!granted) {
            Notice("Android treats wifi scanning as location.", "Allow location") {
                launcher.launch(WifiScanner.requiredPermissions().toTypedArray())
            }
        }
        if (state.locationOff) {
            Notice("Turn on Location for wifi scans to work", "Open location settings") {
                openSettings(context, Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            }
        }
        if (state.throttled) {
            Notice(
                "Scans are throttled to 4 per 2 minutes. Turn off Developer options > Networking > Wi-Fi scan throttling",
                "Open developer options",
            ) { openSettings(context, Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS) }
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }

        OutlinedButton(onClick = onLearn, modifier = Modifier.fillMaxWidth()) { Text("Open learn mode") }
        TextButton(
            onClick = {
                ScanService.stop(context)
                prefs.signOut()
                Tracker.state.value = TrackerState()
                onSignOut()
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Sign out") }
    }
}

@Composable
private fun Notice(message: String, action: String, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(message)
            Button(onClick = onClick) { Text(action) }
        }
    }
}

private fun parseColor(hex: String?): Color =
    runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(Color.Gray)
