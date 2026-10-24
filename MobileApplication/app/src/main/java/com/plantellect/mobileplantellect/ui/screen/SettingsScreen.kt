package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
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

    PlantellectPage {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            PageHeading("Preferences", "Settings", "Make Plantellect look and work the way you like.")

            SectionTitle("Appearance")
            SettingsCard {
                ThemeOption(
                    "📱",
                    "System default",
                    "Follow your phone's light or dark setting.",
                    selected = themeMode == ThemeMode.SYSTEM) {
                    settings.setThemeMode(ThemeMode.SYSTEM) }
                ThemeOption(
                    "☀️",
                    "Light",
                    "Bright and fresh.",
                    selected = themeMode == ThemeMode.LIGHT) {
                    settings.setThemeMode(ThemeMode.LIGHT) }
                ThemeOption(
                    "🌙",
                    "Dark",
                    "Easier on the eyes at night.",
                    selected = themeMode == ThemeMode.DARK) {
                    settings.setThemeMode(ThemeMode.DARK) }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                SwitchRow(
                    title = "Match my wallpaper",
                    description = "Use your phone's Material You colors instead of " +
                            "Plantellect green.",
                    checked = dynamicColor,
                    onCheckedChange = { settings.setDynamicColor(it) }
                )
            }

            SectionTitle("Scanning")
            SettingsCard {
                SwitchRow(
                    title = "Developer mode",
                    description = "Show technical scan details such as confidence percentages " +
                            "and the server connection. Leave off for simple, everyday results.",
                    checked = debug,
                    onCheckedChange = { settings.setDebugMode(it) }
                )
                if (debug) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Text("Server connection", style = MaterialTheme.typography.titleMedium)
                        Text(
                            connectionText(serverStatus),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

private fun connectionText(status: ServerStatus): String {
    val seconds = ServerMonitor.CHECK_INTERVAL_MS / 1000
    return when (status) {
        ServerStatus.CHECKING -> "Checking…"
        ServerStatus.ONLINE -> "Online. Rechecked every $seconds seconds."
        ServerStatus.NO_NETWORK -> "No network. Scans run on this phone. Rechecked every $seconds seconds."
        ServerStatus.SERVER_UNREACHABLE -> "Server unreachable. Scans run on this phone. Rechecked every $seconds seconds."
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground)
}

@Composable
private fun SettingsCard(content: @Composable ColumnScope.() -> Unit) {
    Card(
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.fillMaxWidth(), content = content)
    }
}

@Composable
private fun ThemeOption(emoji: String, title: String, description: String, selected: Boolean, onSelect: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, onClick = onSelect, role = Role.RadioButton)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text(emoji, style = MaterialTheme.typography.headlineSmall)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
            Text(description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        RadioButton(selected = selected, onClick = null)
    }
}

@Composable
private fun SwitchRow(title: String, description: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(value = checked, onValueChange = onCheckedChange, role = Role.Switch)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
            Text(description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = null)
    }
}
