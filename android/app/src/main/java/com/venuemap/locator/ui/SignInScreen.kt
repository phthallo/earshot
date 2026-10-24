package com.venuemap.locator.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.venuemap.locator.Api
import com.venuemap.locator.ApiException
import com.venuemap.locator.Prefs
import com.venuemap.locator.Tracker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun SignInScreen(prefs: Prefs, onSignedIn: () -> Unit) {
    var baseUrl by remember { mutableStateOf(prefs.baseUrl) }
    var code by remember { mutableStateOf(prefs.pairCode ?: "") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Venue Locator", style = MaterialTheme.typography.headlineMedium)
        Text("Enter the pair code shown on the web map after you register.")
        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it },
            label = { Text("Bridge URL") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = code,
            onValueChange = { code = it.uppercase().filter { c -> c.isLetterOrDigit() }.take(6) },
            label = { Text("Pair code") },
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace, letterSpacing = 4.sp),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            onClick = {
                busy = true
                error = null
                val base = baseUrl.trim()
                scope.launch {
                    try {
                        val person = withContext(Dispatchers.IO) { Api.login(base, code) }
                        prefs.baseUrl = base
                        prefs.pairCode = code
                        prefs.person = person
                        Tracker.update { it.copy(person = person) }
                        onSignedIn()
                    } catch (e: ApiException) {
                        error = e.message
                    } catch (e: Exception) {
                        error = "Could not reach $base"
                    }
                    busy = false
                }
            },
            enabled = code.length == 6 && !busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (busy) "Signing in" else "Sign in")
        }
    }
}
