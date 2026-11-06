package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LocalFlorist
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/*
 * The sidebar, in one place. The app's main screens and the plant profile (which opens over them as its own
 * full screen window) both show THIS sheet, so the two always list the same pages in the same order.
 *
 * It has exactly seven pages. Sign out is not a page: it is the small icon at the top of the sidebar.
 */

/** requires = a permission string from the server; null means every signed-in user sees it. */
internal data class DrawerEntry(val label: String, val route: String, val icon: ImageVector, val requires: String? = null)

internal val drawerEntries = listOf(
    DrawerEntry("Home", "home", Icons.Filled.Home),
    DrawerEntry("Plant Library", "inventory", Icons.Filled.LocalFlorist),
    DrawerEntry("Capture Plant", "scan", Icons.Filled.CameraAlt),
    DrawerEntry("Record Plant", "record", Icons.Filled.EditNote, requires = "record_plant"),
    DrawerEntry("Discoveries", "discoveries", Icons.Filled.Explore, requires = "record_plant"),
    DrawerEntry("Profile", "profile", Icons.Filled.Person),
    DrawerEntry("Settings", "settings", Icons.Filled.Settings)
)

/**
 * What a screen needs to use the sidebar from anywhere, even from inside a dialog: which pages this person may
 * see, how to go to one, and how to start signing out. Provided once by the app shell.
 */
internal class AppNav(
    val permissions: List<String>,
    val go: (String) -> Unit,
    val signOut: () -> Unit
)

internal val LocalAppNav = compositionLocalOf<AppNav?> { null }

/** Compact sidebar: 208 dp, wider only when the phone's font size is large so labels still fit. */
@Composable
internal fun drawerWidth(): Dp {
    val fontScale = LocalDensity.current.fontScale
    return (208 * fontScale.coerceIn(1f, 1.5f)).dp
}

@Composable
internal fun PlantellectDrawerSheet(
    permissions: List<String>,
    currentRoute: String?,
    onGo: (String) -> Unit,
    onSignOut: () -> Unit
) {
    val c = MaterialTheme.colorScheme
    // Rows and width grow with the phone's font size, so larger text is never cut off.
    val rowHeight = (48 * LocalDensity.current.fontScale.coerceIn(1f, 1.5f)).dp
    ModalDrawerSheet(drawerContainerColor = c.background, modifier = Modifier.width(drawerWidth())) {
        Row(
            Modifier.padding(start = 14.dp, end = 6.dp, top = 12.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            LogoMark(32.dp)
            Text(
                "Plantellect", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, color = c.onSurface,
                maxLines = 2, overflow = TextOverflow.Ellipsis
            )
            IconButton(onClick = onSignOut, modifier = Modifier.size(40.dp)) {
                Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = "Sign out", tint = c.error)
            }
        }
        HorizontalDivider(color = c.outlineVariant)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
            drawerEntries.filter { it.requires == null || it.requires in permissions }.forEach { e ->
                NavigationDrawerItem(
                    label = { Text(e.label, style = MaterialTheme.typography.labelLarge, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    icon = { Icon(e.icon, contentDescription = null) },
                    selected = currentRoute == e.route,
                    onClick = { onGo(e.route) },
                    shape = MaterialTheme.shapes.small,
                    colors = NavigationDrawerItemDefaults.colors(
                        selectedContainerColor = c.primaryContainer,
                        unselectedContainerColor = Color.Transparent,
                        selectedIconColor = c.primary,
                        unselectedIconColor = c.onSurfaceVariant,
                        selectedTextColor = c.onSurface,
                        unselectedTextColor = c.onSurface
                    ),
                    modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding).height(rowHeight)
                )
            }
        }
    }
}
