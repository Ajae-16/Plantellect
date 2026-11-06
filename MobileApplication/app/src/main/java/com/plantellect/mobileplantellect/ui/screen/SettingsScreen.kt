package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.data.local.ThemeMode
import com.plantellect.mobileplantellect.data.logic.ServerMonitor
import com.plantellect.mobileplantellect.data.logic.ServerStatus
import com.plantellect.mobileplantellect.data.repository.ScanRepository
import com.plantellect.mobileplantellect.ui.theme.TypeCombo

@Composable
fun SettingsScreen() {
    val app = LocalContext.current.applicationContext as PlantellectApp
    val settings = app.container.settings
    val themeMode by settings.themeMode.collectAsStateWithLifecycle()
    val dynamicColor by settings.dynamicColor.collectAsStateWithLifecycle()
    val debug by settings.debugMode.collectAsStateWithLifecycle()
    val autoContribute by settings.autoContribute.collectAsStateWithLifecycle()
    val offlineMode by settings.offlineMode.collectAsStateWithLifecycle()
    val typeComboName by settings.typeCombo.collectAsStateWithLifecycle()
    val typeCombo = TypeCombo.fromName(typeComboName)
    var confirmContribute by remember { mutableStateOf(false) }
    val serverStatus by app.container.serverMonitor.status.collectAsStateWithLifecycle()
    val divider = MaterialTheme.colorScheme.outlineVariant

    @Composable
    fun Theme(title: String, desc: String, mode: ThemeMode) = OptionRow(
        title, desc,
        Modifier.selectable(selected = themeMode == mode, role = Role.RadioButton, onClick = { settings.setThemeMode(mode) })
    ) { RadioButton(selected = themeMode == mode, onClick = null) }

    @Composable
    fun Toggle(title: String, desc: String, checked: Boolean, onChange: (Boolean) -> Unit) = OptionRow(
        title, desc, Modifier.toggleable(value = checked, role = Role.Switch, onValueChange = onChange)
    ) { Switch(checked = checked, onCheckedChange = null) }

    PlantellectPage {
        PageHeading("Preferences", "Settings", "Make Plantellect look and work the way you like.")

        SectionTitle("Appearance")
        PlantSurface(Modifier.fillMaxWidth()) {
            Theme("System default", "Follow your phone's light or dark setting.", ThemeMode.SYSTEM)
            Theme("Light", "Bright and fresh.", ThemeMode.LIGHT)
            Theme("Dark", "Easier on the eyes at night.", ThemeMode.DARK)
            HorizontalDivider(color = divider)

        }

        SectionTitle("Typography")
        PlantSurface(Modifier.fillMaxWidth()) {
            TypeCombo.entries.forEach { combo ->
                OptionRow(
                    combo.title, combo.blurb,
                    Modifier.selectable(
                        selected = typeCombo == combo, role = Role.RadioButton,
                        onClick = { settings.setTypeCombo(combo.name) }
                    )
                ) { RadioButton(selected = typeCombo == combo, onClick = null) }
            }
        }

        SectionTitle("Scanning")
        PlantSurface(Modifier.fillMaxWidth()) {
            Toggle(
                "Offline mode",
                "Scan with the model on your phone only and never contact the server. Turn it off to prefer the server: " +
                        "if it can't be reached, the app waits ${ScanRepository.SERVER_RETRY_WAIT_SECONDS} seconds and tries again " +
                        "before using the model on your phone.",
                offlineMode, settings::setOfflineMode
            )
        }

        SectionTitle("Privacy")
        PlantSurface(Modifier.fillMaxWidth()) {
            Toggle(
                "Help improve",
                "Automatically share the photos you scan to train the plant model, so you do not have to tap \"Help improve\" after every scan. Never shown publicly.",
                autoContribute
            ) { on ->
                // Turning it on needs a confirmation; turning it off is immediate.
                if (on) confirmContribute = true else settings.setAutoContribute(false)
            }
        }

        SectionTitle("Developer Option")
        PlantSurface(Modifier.fillMaxWidth()) {
            Toggle(
                "Developer mode",
                "Show technical scan details such as confidence percentages and the server connection. Leave off for simple, everyday results.",
                debug, settings::setDebugMode
            )
            if (debug) {
                HorizontalDivider(color = divider)
                OptionRow("Server connection", connectionText(serverStatus)) {}
            }
        }
    }

    if (confirmContribute) {
        AlertDialog(
            onDismissRequest = { confirmContribute = false },   // cancel: the switch stays off
            title = { Text("Help improve") },
            text = { Text("The photo you scanned will be used for training.") },
            confirmButton = {
                TextButton(onClick = {
                    settings.setAutoContribute(true)
                    confirmContribute = false
                }) { Text("Turn on") }
            },
            dismissButton = { TextButton(onClick = { confirmContribute = false }) { Text("Cancel") } }
        )
    }
}

private fun connectionText(status: ServerStatus): String {
    val s = ServerMonitor.CHECK_INTERVAL_MS / 1000
    return when (status) {
        ServerStatus.CHECKING -> "Checking…"
        ServerStatus.ONLINE -> "Online. Rechecked every $s seconds."
        ServerStatus.NO_NETWORK -> "No network. Scans run on this phone. Rechecked every $s seconds."
        ServerStatus.SERVER_UNREACHABLE -> "Server unreachable. Scans run on this phone. Rechecked every $s seconds."
        ServerStatus.OFFLINE_MODE -> "Offline mode is on. The server is not contacted."
    }
}