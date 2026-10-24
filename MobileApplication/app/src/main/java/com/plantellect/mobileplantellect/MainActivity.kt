package com.plantellect.mobileplantellect

import android.graphics.Color as AndroidColor
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Eco
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.plantellect.mobileplantellect.data.repository.AuthState
import com.plantellect.mobileplantellect.ui.screen.HomeScreen
import com.plantellect.mobileplantellect.ui.screen.LoginScreen
import com.plantellect.mobileplantellect.ui.screen.PlantInventoryScreen
import com.plantellect.mobileplantellect.ui.screen.ProfileScreen
import com.plantellect.mobileplantellect.ui.screen.RecordPlantScreen
import com.plantellect.mobileplantellect.ui.screen.ScanPlantScreen
import com.plantellect.mobileplantellect.ui.screen.SettingsScreen
import com.plantellect.mobileplantellect.ui.theme.MobilePlantellectTheme
import com.plantellect.mobileplantellect.ui.theme.resolveDark
import com.plantellect.mobileplantellect.viewmodel.AuthViewModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Built once in PlantellectApp (declare it in the manifest: android:name=".PlantellectApp").
        val container = (application as PlantellectApp).container
        val factory = container.viewModelFactory

        setContent {
            // The user's theme choice (System / Light / Dark) decides the colors AND the status/nav bar icons.
            val themeMode by container.settings.themeMode.collectAsState()
            val dynamicColor by container.settings.dynamicColor.collectAsState()
            val darkTheme = themeMode.resolveDark(isSystemInDarkTheme())

            DisposableEffect(darkTheme) {
                this@MainActivity.enableEdgeToEdge(
                    statusBarStyle = SystemBarStyle.auto(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT) { darkTheme },
                    navigationBarStyle = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { darkTheme }
                )
                onDispose { }
            }

            MobilePlantellectTheme(darkTheme = darkTheme, dynamicColor = dynamicColor) {
                // Activity-scoped, so the login screen, the drawer and ProfileScreen all see the SAME login state.
                val auth: AuthViewModel = viewModel(factory = factory)
                val authState by auth.authState.collectAsState()
                val authUi by auth.ui.collectAsState()

                GradientBackground {
                    when (val state = authState) {
                        // /me is still being checked on launch.
                        AuthState.Unknown -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(14.dp)
                            ) {
                                CircularProgressIndicator()
                                Text(
                                    "Getting things ready…",
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.onBackground
                                )
                            }
                        }
                        // Also what the user returns to if the server drops the session.
                        AuthState.SignedOut -> LoginScreen(
                            busy = authUi.busy,
                            errorMessage = authUi.error,
                            fieldErrors = authUi.fieldErrors,
                            onInputChanged = {
                                if (authUi.error != null || authUi.fieldErrors.isNotEmpty()) auth.consumeMessages()
                            },
                            onLogin = { identifier, password ->
                                auth.login(identifier, password, rememberMe = false)
                            },
                            onRegister = { form, confirmPassword, certificate ->
                                auth.register(form, certificate, confirmPassword)
                            }
                        )
                        is AuthState.SignedIn -> AppShell(
                            auth = auth,
                            permissions = state.account.permissions
                        )
                    }
                }
            }
        }
    }

    // The server monitor only runs while the app is on screen (no 10-second pings in the background).
    override fun onStart() {
        super.onStart()
        (application as PlantellectApp).container.serverMonitor.start()
    }

    override fun onStop() {
        (application as PlantellectApp).container.serverMonitor.stop()
        super.onStop()
    }

    private companion object {
        val LIGHT_SCRIM = AndroidColor.argb(0xE6, 0xFF, 0xFF, 0xFF)
        val DARK_SCRIM = AndroidColor.argb(0x80, 0x1B, 0x1B, 0x1B)
    }
}

/**
 * The gradient sits BEHIND everything. Children must use transparent containers
 * (the Scaffold below does) or they will paint over it.
 */
@Composable
private fun GradientBackground(content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                brush = Brush.linearGradient(
                    colors = listOf(
                        MaterialTheme.colorScheme.primaryContainer,
                        MaterialTheme.colorScheme.secondaryContainer,
                        MaterialTheme.colorScheme.tertiaryContainer
                    ),
                    start = Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY),
                    end = Offset.Zero,
                    tileMode = TileMode.Clamp
                )
            )
    ) {
        content()
    }
}

/** requires = a permission string from the server; null means every signed-in user sees it. */
private data class DrawerEntry(
    val label: String,
    val route: String,
    val icon: ImageVector,
    val requires: String? = null
)

private val drawerEntries = listOf(
    DrawerEntry("Home", "home", Icons.Default.Home),
    DrawerEntry("Plants", "inventory", Icons.Default.Eco),
    DrawerEntry("Scan a Plant", "scan", Icons.Default.CameraAlt),
    DrawerEntry("Record a Plant", "record", Icons.Default.AddAPhoto, requires = "record_plant"),
    DrawerEntry("Profile", "profile", Icons.Default.Person)
)

private const val SETTINGS_ROUTE = "settings"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppShell(
    auth: AuthViewModel,
    permissions: List<String>
) {
    val navController = rememberNavController()
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val currentRoute = navController.currentBackStackEntryAsState().value?.destination?.route
    val authUi by auth.ui.collectAsState()
    var showSignOutDialog by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme

    // The ONE way to switch screens. The drawer AND the Home feature cards both use it, so the
    // back stack is always [home, <current screen>] and never gets a stray screen stacked on Home.
    fun go(route: String) {
        scope.launch { drawerState.close() }
        if (route == "home") {
            // Home is the root: just pop back to it. Using restoreState here would bring back a
            // previously saved screen (e.g. Scan) on top of Home, which was the "Home shows Scan" bug.
            navController.popBackStack("home", inclusive = false)
        } else {
            navController.navigate(route) {
                // One copy of each top-level screen; back returns to Home instead of stacking.
                popUpTo("home") { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
        }
    }

    // A botanist sign-up signs the user in right away, so the "awaiting review" / "approved" note is shown here.
    authUi.notice?.let { notice ->
        AlertDialog(
            onDismissRequest = { auth.consumeMessages() },
            icon = { Icon(Icons.Default.Eco, contentDescription = null, tint = colors.primary) },
            title = { Text("Welcome to Plantellect") },
            text = { Text(notice) },
            confirmButton = { TextButton(onClick = { auth.consumeMessages() }) { Text("OK") } }
        )
    }

    if (showSignOutDialog) {
        AlertDialog(
            // Can't be dismissed while the request is running, so it never gets stuck half-way.
            onDismissRequest = { if (!authUi.signingOut) showSignOutDialog = false },
            icon = {
                Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, tint = colors.error)
            },
            title = { Text("Sign out?") },
            text = {
                if (authUi.signingOut) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.5.dp)
                        Spacer(Modifier.width(14.dp))
                        Text("Signing you out…")
                    }
                } else {
                    Text("You'll need to sign in again to scan plants and manage your collection.")
                }
            },
            confirmButton = {
                TextButton(onClick = { auth.logout() }, enabled = !authUi.signingOut) {
                    Text("Sign out", color = colors.error)   // state flips to SignedOut and MainActivity shows LoginScreen
                }
            },
            dismissButton = {
                TextButton(onClick = { showSignOutDialog = false }, enabled = !authUi.signingOut) {
                    Text("Cancel")
                }
            }
        )
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                drawerContainerColor = colors.primaryContainer,
                modifier = Modifier.fillMaxWidth(0.7f).widthIn(max = 320.dp)
            ) {
                Text(
                    "Plantellect",
                    style = MaterialTheme.typography.headlineMedium,
                    color = colors.onSurface,
                    modifier = Modifier.padding(16.dp)
                )
                HorizontalDivider()

                // Main destinations scroll if the phone is small; Settings + Sign out stay pinned below.
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(vertical = 8.dp)
                ) {
                    drawerEntries
                        .filter { it.requires == null || it.requires in permissions }
                        .forEach { entry ->
                            NavigationDrawerItem(
                                icon = { Icon(entry.icon, contentDescription = null) },
                                label = {
                                    Text(
                                        entry.label,
                                        style = MaterialTheme.typography.labelLarge,
                                        color = colors.onSurface
                                    )
                                },
                                selected = currentRoute == entry.route,
                                onClick = { go(entry.route) },
                                modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding)
                            )
                        }
                }

                HorizontalDivider()
                Column(Modifier.padding(vertical = 8.dp)) {
                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.Settings, contentDescription = null) },
                        label = {
                            Text(
                                "Settings",
                                style = MaterialTheme.typography.labelLarge,
                                color = colors.onSurface
                            )
                        },
                        selected = currentRoute == SETTINGS_ROUTE,
                        onClick = { go(SETTINGS_ROUTE) },
                        modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding)
                    )
                    NavigationDrawerItem(
                        icon = { Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, tint = colors.error) },
                        label = {
                            Text(
                                "Sign out",
                                style = MaterialTheme.typography.labelLarge,
                                color = colors.error
                            )
                        },
                        selected = false,
                        onClick = {
                            scope.launch { drawerState.close() }
                            showSignOutDialog = true   // confirm first; nothing is signed out yet
                        },
                        modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding)
                    )
                }
            }
        }
    ) {
        Scaffold(
            containerColor = Color.Transparent,   // lets the gradient show through
            topBar = {
                CenterAlignedTopAppBar(
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                        containerColor = Color.Transparent
                    ),
                    title = {
                        Text(
                            "Plantellect",
                            style = MaterialTheme.typography.headlineMedium,
                            color = colors.onSurface
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawerState.open() } }) {
                            Icon(Icons.Default.Menu, contentDescription = "Menu")
                        }
                    }
                )
            }
        ) { innerPadding ->
            NavHost(
                navController = navController,
                startDestination = "home",
                modifier = Modifier.padding(innerPadding)
            ) {
                composable("home") { HomeScreen(
                    onNavigateToScan = { go("scan") },
                    onNavigateToInventory = { go("inventory") }
                ) }
                // Each screen fetches its own ViewModel (see ui/AppViewModel.kt), so these calls keep
                // the screens' current signatures.
                composable("inventory") { PlantInventoryScreen() }
                composable("scan") { ScanPlantScreen() }
                composable("record") { RecordPlantScreen() }
                composable("profile") { ProfileScreen() }
                composable(SETTINGS_ROUTE) { SettingsScreen() }
            }
        }
    }
}