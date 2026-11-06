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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LocalFlorist
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
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
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.plantellect.mobileplantellect.data.remote.dto.AccountDto
import com.plantellect.mobileplantellect.data.repository.AuthState
import com.plantellect.mobileplantellect.ui.screen.*
import com.plantellect.mobileplantellect.ui.theme.MobilePlantellectTheme
import com.plantellect.mobileplantellect.ui.theme.TypeCombo
import com.plantellect.mobileplantellect.ui.theme.resolveDark
import com.plantellect.mobileplantellect.viewmodel.AuthViewModel
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
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
            val typeComboName by container.settings.typeCombo.collectAsState()

            DisposableEffect(darkTheme) {
                this@MainActivity.enableEdgeToEdge(
                    statusBarStyle = SystemBarStyle.auto(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT) { darkTheme },
                    navigationBarStyle = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { darkTheme }
                )
                onDispose { }
            }

            // "Match my wallpaper" removed: the app always uses the Plantellect greens.
            MobilePlantellectTheme(darkTheme = darkTheme, dynamicColor = false, typeCombo = TypeCombo.fromName(typeComboName)) {
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
                            onRegister = { form, confirm -> auth.register(form, confirm) }
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
    // The one background of the app (see plantBackdrop): every screen, the login page and the plant profile share it.
    Box(Modifier.fillMaxSize().plantBackdrop()) {
        // Default text color for everything on the gradient: light in dark mode, dark in light mode.
        CompositionLocalProvider(LocalContentColor provides c.onBackground) { content() }
    }
}

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
    // Same instance Home and the Library use (it is scoped to the Activity).
    val libraryVm = libraryViewModel()
    var showSignOutDialog by remember { mutableStateOf(false) }
    // True when your own profile was opened by tapping your name (it then gets a Back button);
    // false when it was opened from the sidebar (no Back button).
    var profileViaLink by rememberSaveable { mutableStateOf(false) }
    val c = MaterialTheme.colorScheme

    fun go(route: String) {
        scope.launch { drawerState.close() }
        if (route == "profile") profileViaLink = false
        if (route == "home") navController.popBackStack("home", inclusive = false)
        else navController.navigate(route) {
            popUpTo("home") { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    /**
     * Opens a person's profile. Your own name goes to your own Profile page; anyone else goes to
     * "profile/{accountId}", the same screen in read-only mode. Both get a Back button that returns to where
     * the name was tapped (a profile opened from the sidebar has no Back button).
     */
    fun openPerson(accountId: String) {
        scope.launch { drawerState.close() }
        if (accountId == account.accountId) {
            profileViaLink = true
            navController.navigate("profile") { launchSingleTop = true }
        } else navController.navigate("profile/$accountId") { launchSingleTop = true }
    }

    // Lets the plant profile (a separate full-screen window) show the same sidebar.
    val appNav = remember(permissions) {
        AppNav(permissions, go = { route -> go(route) }, signOut = { showSignOutDialog = true })
    }

    authUi.notice?.let { notice ->
        AlertDialog(
            onDismissRequest = { auth.consumeMessages() },
            title = { Text("Welcome to Plantellect") },
            text = { Text(notice) },
            confirmButton = { PlantTextButton({ auth.consumeMessages() }) { Text("OK") } }
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
            confirmButton = { PlantTextButton({ auth.logout() }, enabled = !authUi.signingOut) { Text("Sign out", color = c.error) } },
            dismissButton = { PlantTextButton({ showSignOutDialog = false }, enabled = !authUi.signingOut) { Text("Cancel") } }
        )
    }

    CompositionLocalProvider(LocalAppNav provides appNav) {
    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            // Seven pages; Sign out is the icon at the top of the sheet.
            PlantellectDrawerSheet(
                permissions = permissions,
                currentRoute = currentRoute,
                onGo = { route -> go(route) },
                onSignOut = { scope.launch { drawerState.close() }; showSignOutDialog = true }
            )
        }
    ) {
        Scaffold(
            containerColor = Color.Transparent,
            topBar = {
                CenterAlignedTopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
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
            // imePadding lifts every screen above the keyboard (edge-to-edge mode ignores adjustResize), and the
            // formatting bar of the description box being typed in is pinned right above the keyboard.
            val richToolbar = remember { RichToolbarHost() }
            CompositionLocalProvider(LocalRichToolbarHost provides richToolbar) {
                Column(Modifier.padding(innerPadding).imePadding()) {
                    Box(Modifier.weight(1f)) {
                NavHost(navController, startDestination = "home", modifier = Modifier.fillMaxSize()) {
                    composable("home") {
                        HomeScreen(
                            onNavigateToScan = { go("scan") },
                            onNavigateToInventory = { go("inventory") },
                            vm = libraryVm,
                            onOpenBotanist = { id -> openPerson(id) }
                        )
                    }
                    composable("inventory") { PlantInventoryScreen(vm = libraryVm, onOpenBotanist = { id -> openPerson(id) }) }
                    composable("scan") { ScanPlantScreen() }
                    composable("record") { RecordPlantScreen() }
                    composable("discoveries") {
                        DiscoveriesScreen(
                            myAccountId = account.accountId,
                            onRecord = { go("record") },
                            // The reporter's name on each card opens their profile.
                            onOpenBotanist = { id -> openPerson(id) }
                        )
                    }
                    // Your own profile: identity, security, My reports, My contributions.
                    // Back shows only when it was opened by tapping your name, not from the sidebar.
                    composable("profile") {
                        Column(Modifier.fillMaxSize()) {
                            if (profileViaLink) BackBar { navController.popBackStack() }
                            Box(Modifier.weight(1f)) {
                                ProfileHost(
                                    account = account, profileVm = profileVm, libraryVm = libraryVm, baseUrl = baseUrl,
                                    viewAccountId = null, onOpenPerson = { id -> openPerson(id) }
                                )
                            }
                        }
                    }
                    // Somebody else's profile: the same screen, read-only.
                    composable(
                        "profile/{accountId}",
                        arguments = listOf(navArgument("accountId") { type = NavType.StringType })
                    ) { entry ->
                        Column(Modifier.fillMaxSize()) {
                            // Back to wherever this profile was opened from (the plant, the list, a report).
                            BackBar { navController.popBackStack() }
                            Box(Modifier.weight(1f)) {
                                ProfileHost(
                                    account = account, profileVm = profileVm, libraryVm = libraryVm, baseUrl = baseUrl,
                                    viewAccountId = entry.arguments?.getString("accountId"),
                                    onOpenPerson = { id -> openPerson(id) }
                                )
                            }
                        }
                    }
                    composable("settings") { SettingsScreen() }
                }
                    }
                    RichToolbarBar(richToolbar)
                }
            }
        }
    }
    }
}

/** "← Back", shown above a profile that was opened from somewhere else (a plant, a list, a report). */
@Composable
private fun BackBar(onBack: () -> Unit) {
    Row(Modifier.padding(horizontal = 8.dp)) {
        PlantTextButton(onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text("Back")
        }
    }
}

/**
 * The one profile screen plus the plant profile that opens when a plant in it is tapped.
 * [viewAccountId] null = your own profile.
 */
@Composable
private fun ProfileHost(
    account: AccountDto,
    profileVm: ProfileViewModel,
    libraryVm: LibraryViewModel,
    baseUrl: String,
    viewAccountId: String?,
    onOpenPerson: (String) -> Unit
) {
    var openPlant by rememberSaveable { mutableStateOf<String?>(null) }
    var resumePlant by rememberSaveable { mutableStateOf<String?>(null) }   // plant to bring back after a profile
    LaunchedEffect(Unit) { if (resumePlant != null) { openPlant = resumePlant; resumePlant = null } }

    ProfileScreen(
        account = account,
        vm = profileVm,
        baseUrl = baseUrl,
        // AppShell only exists while signed in, so there is nothing to sign in to here.
        onSignIn = { },
        myAccountId = account.accountId,
        viewAccountId = viewAccountId,
        onOpenPlant = { id -> openPlant = id }
    )

    openPlant?.let { id ->
        PlantProfileDialog(
            plantId = id,
            fallbackName = "Plant",
            heroUrl = null,
            vm = libraryVm,
            onOpenBotanist = { person -> resumePlant = openPlant; openPlant = null; onOpenPerson(person) },
            onClose = { openPlant = null }
        )
    }
}
