package com.venuemap.locator.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.venuemap.locator.Api
import com.venuemap.locator.Prefs
import com.venuemap.locator.WifiScanner
import com.venuemap.locator.Zone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val SAMPLES_PER_RECORDING = 3

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LearnScreen(prefs: Prefs, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val scanner = remember { WifiScanner(context) }
    var zones by remember { mutableStateOf<List<Zone>>(emptyList()) }
    var selectedId by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var recording by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf<String?>(null) }
    var toDelete by remember { mutableStateOf<Zone?>(null) }

    LaunchedEffect(Unit) {
        try {
            zones = withContext(Dispatchers.IO) { Api.zones(prefs.baseUrl) }
        } catch (e: Exception) {
            error = e.message ?: "Could not load zones"
        }
    }

    fun record(zone: Zone) {
        recording = true
        error = null
        progress = "Scanning"
        scope.launch {
            var done = 0
            var attempts = 0
            while (done < SAMPLES_PER_RECORDING && attempts < 12) {
                attempts++
                val outcome = scanner.scan()
                if (outcome.scans.isEmpty()) {
                    progress = "No access points found"
                } else if (!outcome.fresh) {
                    progress = "Waiting for a fresh scan, throttled"
                } else {
                    try {
                        val samples = withContext(Dispatchers.IO) { Api.learn(prefs.baseUrl, zone.zoneId, outcome.scans) }
                        done++
                        zones = zones.map { if (it.zoneId == zone.zoneId) it.copy(samples = samples) else it }
                        progress = "Recorded $done of $SAMPLES_PER_RECORDING"
                    } catch (e: Exception) {
                        error = e.message ?: "Request failed"
                        break
                    }
                }
                if (done < SAMPLES_PER_RECORDING) delay(5_000)
            }
            recording = false
        }
    }

    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 8.dp)) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            Text("Learn mode", style = MaterialTheme.typography.titleLarge)
        }
        Text(
            "Stand in a zone, pick it, then record. Long press a zone to delete its samples.",
            modifier = Modifier.padding(horizontal = 24.dp),
            style = MaterialTheme.typography.bodySmall,
        )
        LazyColumn(Modifier.weight(1f).padding(vertical = 8.dp)) {
            items(zones, key = { it.zoneId }) { zone ->
                val selected = zone.zoneId == selectedId
                ListItem(
                    headlineContent = { Text(zone.name) },
                    supportingContent = { Text("${zone.samples} samples, floor ${zone.floor}") },
                    trailingContent = {
                        IconButton(onClick = { toDelete = zone }) {
                            Icon(Icons.Filled.Delete, contentDescription = "Delete samples")
                        }
                    },
                    colors = ListItemDefaults.colors(
                        containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
                    ),
                    modifier = Modifier.combinedClickable(
                        enabled = !recording,
                        onClick = { selectedId = zone.zoneId },
                        onLongClick = { toDelete = zone },
                    ),
                )
            }
        }
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            progress?.let { Text(it) }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = { zones.firstOrNull { it.zoneId == selectedId }?.let(::record) },
                enabled = selectedId != null && !recording,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Record here") }
        }
    }

    toDelete?.let { zone ->
        AlertDialog(
            onDismissRequest = { toDelete = null },
            title = { Text("Delete samples for ${zone.name}?") },
            confirmButton = {
                TextButton(onClick = {
                    toDelete = null
                    scope.launch {
                        try {
                            withContext(Dispatchers.IO) { Api.forget(prefs.baseUrl, zone.zoneId) }
                            zones = zones.map { if (it.zoneId == zone.zoneId) it.copy(samples = 0) else it }
                        } catch (e: Exception) {
                            error = e.message ?: "Request failed"
                        }
                    }
                }) { Text("Delete samples") }
            },
            dismissButton = { TextButton(onClick = { toDelete = null }) { Text("Keep") } },
        )
    }
}
