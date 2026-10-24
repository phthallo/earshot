package com.venuemap.locator

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.venuemap.locator.ui.LearnScreen
import com.venuemap.locator.ui.SignInScreen
import com.venuemap.locator.ui.TrackingScreen

enum class Screen { SignIn, Tracking, Learn }

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        Tracker.update { it.copy(person = prefs.person) }
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) { App(prefs) }
            }
        }
    }
}

@Composable
private fun App(prefs: Prefs) {
    val state by Tracker.state.collectAsStateWithLifecycle()
    var screen by rememberSaveable {
        mutableStateOf(if (prefs.person != null) Screen.Tracking else Screen.SignIn)
    }
    when (screen) {
        Screen.SignIn -> SignInScreen(prefs, onSignedIn = { screen = Screen.Tracking })
        Screen.Tracking -> TrackingScreen(
            prefs, state,
            onLearn = { screen = Screen.Learn },
            onSignOut = { screen = Screen.SignIn },
        )
        Screen.Learn -> LearnScreen(prefs, onBack = { screen = Screen.Tracking })
    }
}

fun openSettings(context: Context, action: String) {
    val flags = Intent.FLAG_ACTIVITY_NEW_TASK
    try {
        context.startActivity(Intent(action).addFlags(flags))
    } catch (e: ActivityNotFoundException) {
        context.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(flags))
    }
}
