package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.data.local.ThemeMode
import com.plantellect.mobileplantellect.data.logic.ServerMonitor
import com.plantellect.mobileplantellect.data.logic.ServerStatus

@Composable
fun SettingsScreen() {
    val app = LocalContext.current.applicationContext as PlantellectApp
    val settings = app.container.settings
    val themeMode by settings.themeMode.collectAsStateWithLifecycle()
    val dynamicColor by settings.dynamicColor.collectAsStateWithLifecycle()
    val debug by settings.debugMode.collectAsStateWithLifecycle()
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
}

private fun connectionText(status: ServerStatus): String {
    val s = ServerMonitor.CHECK_INTERVAL_MS / 1000
    return when (status) {
        ServerStatus.CHECKING -> "Checking…"
        ServerStatus.ONLINE -> "Online. Rechecked every $s seconds."
        ServerStatus.NO_NETWORK -> "No network. Scans run on this phone. Rechecked every $s seconds."
        ServerStatus.SERVER_UNREACHABLE -> "Server unreachable. Scans run on this phone. Rechecked every $s seconds."
    }
}