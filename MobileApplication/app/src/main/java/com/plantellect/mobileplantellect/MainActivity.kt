package com.plantellect.mobileplantellect

import android.content.pm.ActivityInfo
import android.graphics.Color as AndroidColor
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LocalFlorist
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.plantellect.mobileplantellect.data.remote.dto.AccountDto
import com.plantellect.mobileplantellect.data.repository.AuthState
import com.plantellect.mobileplantellect.ui.screen.*
import com.plantellect.mobileplantellect.ui.theme.MobilePlantellectTheme
import com.plantellect.mobileplantellect.ui.theme.resolveDark
import com.plantellect.mobileplantellect.viewmodel.AuthViewModel
import com.plantellect.mobileplantellect.viewmodel.ProfileViewModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The app never rotates: always portrait.
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        enableEdgeToEdge()
        val container = (application as PlantellectApp).container
        val factory = container.viewModelFactory

        setContent {
            val themeMode by container.settings.themeMode.collectAsState()
            val darkTheme = themeMode.resolveDark(isSystemInDarkTheme())

            DisposableEffect(darkTheme) {
                this@MainActivity.enableEdgeToEdge(
                    statusBarStyle = SystemBarStyle.auto(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT) { darkTheme },
                    navigationBarStyle = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { darkTheme }
                )
                onDispose { }
            }

            // "Match my wallpaper" removed: the app always uses the Plantellect greens.
            MobilePlantellectTheme(darkTheme = darkTheme, dynamicColor = false) {
                val auth: AuthViewModel = viewModel(factory = factory)
                val authState by auth.authState.collectAsState()
                val authUi by auth.ui.collectAsState()

                GradientBackground {
                    when (val state = authState) {
                        AuthState.Unknown -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                                LogoMark(96.dp)
                                CircularProgressIndicator()
                                Text("Getting things ready…", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onBackground)
                            }
                        }
                        AuthState.SignedOut -> LoginScreen(
                            busy = authUi.busy,
                            errorMessage = authUi.error,
                            fieldErrors = authUi.fieldErrors,
                            onInputChanged = { if (authUi.error != null || authUi.fieldErrors.isNotEmpty()) auth.consumeMessages() },
                            onLogin = { identifier, password -> auth.login(identifier, password, rememberMe = false) },
                            onRegister = { form, confirm, certificate -> auth.register(form, certificate, confirm) }
                        )
                        is AuthState.SignedIn -> AppShell(
                            auth = auth,
                            account = state.account,
                            factory = factory,
                            baseUrl = container.network.baseUrl.toString()
                        )
                    }
                }
            }
        }
    }

    override fun onStart() { super.onStart(); (application as PlantellectApp).container.serverMonitor.start() }
    override fun onStop() { (application as PlantellectApp).container.serverMonitor.stop(); super.onStop() }

    private companion object {
        val LIGHT_SCRIM = AndroidColor.argb(0xE6, 0xFF, 0xFF, 0xFF)
        val DARK_SCRIM = AndroidColor.argb(0x80, 0x1B, 0x1B, 0x1B)
    }
}

@Composable
private fun GradientBackground(content: @Composable () -> Unit) {
    val c = MaterialTheme.colorScheme
    Box(
        Modifier.fillMaxSize().background(
            Brush.linearGradient(
                colors = listOf(c.primaryContainer, c.secondaryContainer, c.tertiaryContainer),
                start = Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY), end = Offset.Zero, tileMode = TileMode.Clamp
            )
        )
    ) {
        // Default text color for everything on the gradient: light in dark mode, dark in light mode.
        CompositionLocalProvider(LocalContentColor provides c.onBackground) { content() }
    }
}

/** requires = a permission string from the server; null means every signed-in user sees it. */
private data class DrawerEntry(val label: String, val route: String, val icon: ImageVector, val requires: String? = null)

private val drawerEntries = listOf(
    DrawerEntry("Home", "home", Icons.Filled.Home),
    DrawerEntry("Plant Library", "inventory", Icons.Filled.LocalFlorist),
    DrawerEntry("Scan a Plant", "scan", Icons.Filled.CameraAlt),
    DrawerEntry("Record a Plant", "record", Icons.Filled.EditNote, requires = "record_plant"),
    DrawerEntry("Profile", "profile", Icons.Filled.Person),
    DrawerEntry("Settings", "settings", Icons.Filled.Settings)
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppShell(
    auth: AuthViewModel,
    account: AccountDto,
    factory: ViewModelProvider.Factory,
    baseUrl: String
) {
    val permissions = account.permissions
    val navController = rememberNavController()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val currentRoute = navController.currentBackStackEntryAsState().value?.destination?.route
    val authUi by auth.ui.collectAsState()
    val profileVm: ProfileViewModel = viewModel(factory = factory)
    var showSignOutDialog by remember { mutableStateOf(false) }
    val c = MaterialTheme.colorScheme

    fun go(route: String) {
        scope.launch { drawerState.close() }
        if (route == "home") navController.popBackStack("home", inclusive = false)
        else navController.navigate(route) {
            popUpTo("home") { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    authUi.notice?.let { notice ->
        AlertDialog(
            onDismissRequest = { auth.consumeMessages() },
            title = { Text("Welcome to Plantellect") },
            text = { Text(notice) },
            confirmButton = { TextButton({ auth.consumeMessages() }) { Text("OK") } }
        )
    }

    if (showSignOutDialog) {
        AlertDialog(
            onDismissRequest = { if (!authUi.signingOut) showSignOutDialog = false },
            title = { Text("Sign out?") },
            text = {
                if (authUi.signingOut) Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.5.dp)
                    Spacer(Modifier.width(14.dp))
                    Text("Signing you out…")
                } else Text("You'll need to sign in again to scan plants and manage your collection.")
            },
            confirmButton = { TextButton({ auth.logout() }, enabled = !authUi.signingOut) { Text("Sign out", color = c.error) } },
            dismissButton = { TextButton({ showSignOutDialog = false }, enabled = !authUi.signingOut) { Text("Cancel") } }
        )
    }

    @Composable
    fun DrawerItem(label: String, icon: ImageVector, selected: Boolean, color: Color = c.onSurface, onClick: () -> Unit) =
        NavigationDrawerItem(
            label = { Text(label, style = MaterialTheme.typography.labelLarge, color = color) },
            icon = { Icon(icon, contentDescription = null, tint = color) },
            selected = selected, onClick = onClick, shape = MaterialTheme.shapes.small,
            modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding)
        )

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = c.primaryContainer, modifier = Modifier.fillMaxWidth(0.7f).widthIn(max = 320.dp)) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    LogoMark(40.dp)
                    Text("Plantellect", style = MaterialTheme.typography.headlineSmall, color = c.onSurface)
                }
                HorizontalDivider()
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
                    drawerEntries.filter { it.requires == null || it.requires in permissions }.forEach { e ->
                        DrawerItem(e.label, e.icon, currentRoute == e.route) { go(e.route) }
                    }
                }
                HorizontalDivider()
                Column(Modifier.padding(vertical = 8.dp)) {
                    DrawerItem("Sign out", Icons.AutoMirrored.Filled.Logout, false, c.error) {
                        scope.launch { drawerState.close() }
                        showSignOutDialog = true
                    }
                }
            }
        }
    ) {
        Scaffold(
            containerColor = Color.Transparent,
            topBar = {
                CenterAlignedTopAppBar(
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = Color.Transparent),
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            LogoMark(30.dp)
                            Text("Plantellect", style = MaterialTheme.typography.headlineSmall, color = c.onSurface)
                        }
                    },
                    navigationIcon = {
                        IconButton({ scope.launch { drawerState.open() } }) {
                            Icon(Icons.Filled.Menu, contentDescription = "Menu")
                        }
                    }
                )
            }
        ) { innerPadding ->
            NavHost(navController, startDestination = "home", modifier = Modifier.padding(innerPadding)) {
                composable("home") { HomeScreen(onNavigateToScan = { go("scan") }, onNavigateToInventory = { go("inventory") }) }
                composable("inventory") { PlantInventoryScreen() }
                composable("scan") { ScanPlantScreen() }
                composable("record") { RecordPlantScreen() }
                composable("profile") {
                    ProfileScreen(
                        account = account,
                        vm = profileVm,
                        baseUrl = baseUrl,
                        // AppShell only exists while signed in, so there is nothing to sign in to here.
                        onSignIn = { }
                    )
                }
                composable("settings") { SettingsScreen() }
            }
        }
    }
}