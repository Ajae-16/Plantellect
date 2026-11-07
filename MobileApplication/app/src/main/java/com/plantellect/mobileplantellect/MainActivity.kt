package com.plantellect.mobileplantellect

import android.content.pm.ActivityInfo
import android.graphics.Color as AndroidColor
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.material.icons.filled.Refresh
import androidx.navigation.NamedNavArgument
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.plantellect.mobileplantellect.data.logic.ApiResult
import com.plantellect.mobileplantellect.data.remote.dto.AccountDto
import com.plantellect.mobileplantellect.data.repository.AuthState
import com.plantellect.mobileplantellect.ui.screen.*
import com.plantellect.mobileplantellect.ui.theme.ColorTheme
import com.plantellect.mobileplantellect.ui.screen.LocalHapticsEnabled
import com.plantellect.mobileplantellect.ui.theme.MobilePlantellectTheme
import com.plantellect.mobileplantellect.ui.theme.TypeCombo
import com.plantellect.mobileplantellect.ui.theme.resolveDark
import com.plantellect.mobileplantellect.viewmodel.AuthViewModel
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import com.plantellect.mobileplantellect.viewmodel.ProfileViewModel
import kotlinx.coroutines.delay
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
            val colorThemeName by container.settings.colorTheme.collectAsState()
            val hapticsOn by container.settings.hapticsEnabled.collectAsState()

            DisposableEffect(darkTheme) {
                this@MainActivity.enableEdgeToEdge(
                    statusBarStyle = SystemBarStyle.auto(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT) { darkTheme },
                    navigationBarStyle = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { darkTheme }
                )
                onDispose { }
            }

            // "Match my wallpaper" removed: the app always uses the Plantellect greens.
            MobilePlantellectTheme(
                darkTheme = darkTheme, dynamicColor = false, typeCombo = TypeCombo.fromName(typeComboName),
                colorTheme = ColorTheme.fromName(colorThemeName)
            ) {
                val auth: AuthViewModel = viewModel(factory = factory)
                val authState by auth.authState.collectAsState()
                val authUi by auth.ui.collectAsState()

                CompositionLocalProvider(LocalHapticsEnabled provides hapticsOn) {
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
        // The idle bloom lives here, above every page (and the login screen), so the plant grows over the whole screen
        // wherever you are, and wilts the moment the screen is touched.
        CompositionLocalProvider(LocalContentColor provides c.onBackground) {
            IdleBloomHost(Modifier.fillMaxSize()) { content() }
        }
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
    // Developer options are for administrators only: the account must hold "access_admin" (same rule the server uses).
    val isAdmin = "access_admin" in permissions
    val settingsStore = (LocalContext.current.applicationContext as PlantellectApp).container.settings
    // Developer mode is saved on the phone and survives sign-out, so switch it off whenever the signed-in
    // account is not an admin (for example someone else signs in on the same phone, or the role was removed).
    LaunchedEffect(isAdmin) { if (!isAdmin) settingsStore.setDebugMode(false) }
    val navController = rememberNavController()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val currentRoute = navController.currentBackStackEntryAsState().value?.destination?.route
    val authUi by auth.ui.collectAsState()
    val profileVm: ProfileViewModel = viewModel(factory = factory)
    // Same instance Home and the Library use (it is scoped to the Activity).
    val libraryVm = libraryViewModel()
    var showSignOutDialog by remember { mutableStateOf(false) }
    // "Discoveries (n)" in the sidebar: reports nobody has claimed yet (the same number the website's sidebar shows).
    // Only people who can work the queue (record_plant) ever see it.
    val appContainer = (LocalContext.current.applicationContext as PlantellectApp).container
    var discoveryBadge by remember { mutableStateOf(0) }
    var discoveryLoaded by remember { mutableStateOf(false) }
    fun refreshDiscoveryBadge() {
        if ("record_plant" !in permissions) { discoveryBadge = 0; return }
        scope.launch {
            (appContainer.discoveries.count() as? ApiResult.Success)?.let { discoveryBadge = it.value.unclaimed; discoveryLoaded = true }
        }
    }
    // Pull-to-refresh: going up re-creates the page that is showing, so it reads everything again.
    var refreshNonce by remember { mutableStateOf(0) }
    var confirmRefresh by remember { mutableStateOf(false) }
    fun doRefresh() {
        refreshNonce++
        libraryVm.reload()
        profileVm.refreshBadge()
        refreshDiscoveryBadge()
    }
    // True when your own profile was opened by tapping your name (it then gets a Back button);
    // false when it was opened from the sidebar (no Back button).
    var profileViaLink by rememberSaveable { mutableStateOf(false) }
    // The page a contributor's profile was opened from ("inventory" = Plant Library). The sidebar keeps that page
    // highlighted while the profile is open, instead of lighting up the sidebar's own Profile page.
    var profileOrigin by rememberSaveable { mutableStateOf("home") }
    // The plant to bring back when Back is pressed on a profile that was opened from it (kept here, not inside the
    // screens, so it can be dropped when you leave that profile through the sidebar).
    var libraryResume by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }
    var homeResume by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }
    // Set by "Contribute" on a plant's profile: the page the plant was opened from ("home", "inventory", "profile"...)
    // and the plant's name, so Back can bring that plant's card back.
    var contributeOrigin by rememberSaveable { mutableStateOf("home") }
    var contributeName by rememberSaveable { mutableStateOf("") }
    val approvals by profileVm.approvals.collectAsState()
    // "Profile (n)" in the sidebar: requests waiting for my answer + answers to the ones I asked for.
    // One number per sidebar page: whatever is waiting inside that page. The Menu button shows the total.
    // Plant Library: plants added since the last time the Library page was open (counted on this phone, per account).
    // The count is only taken from the unfiltered list, and it is cleared while the Library is showing.
    val libraryUi by libraryVm.ui.collectAsState()
    val prefsContext = LocalContext.current
    val navPrefs = remember { prefsContext.getSharedPreferences("nav_seen", android.content.Context.MODE_PRIVATE) }
    var libraryBadge by remember { mutableStateOf(0) }
    LaunchedEffect(libraryUi.total, libraryUi.loading, libraryUi.query, libraryUi.typeName, currentRoute, account.accountId) {
        if (libraryUi.loading || libraryUi.query.isNotBlank() || libraryUi.typeName != null || libraryUi.total <= 0) return@LaunchedEffect
        val key = "plants_seen_${account.accountId}"
        val seen = navPrefs.getInt(key, -1)
        if (currentRoute == "inventory" || seen < 0) {
            // On the page itself (or the very first run): everything counts as seen.
            navPrefs.edit().putInt(key, libraryUi.total).apply()
            libraryBadge = 0
        } else libraryBadge = (libraryUi.total - seen).coerceAtLeast(0)
    }
    // Every sidebar page reads its number from this one map (route -> count); a page with nothing waiting shows none.
    // What is waiting on each sidebar page (route -> count). What the sidebar SHOWS is worked out below, once it is
    // known which page is open: a page you have seen drops its pill.
    val rawBadges = remember(approvals.badge, discoveryBadge, libraryBadge) {
        mapOf(
            "home" to 0,
            "inventory" to libraryBadge,
            "scan" to 0,
            "record" to 0,
            "discoveries" to discoveryBadge,
            "profile" to approvals.badge,
            "settings" to 0
        )
    }
    val c = MaterialTheme.colorScheme

    /** A profile that sits on top of another page (a contributor's, or yours opened by tapping your name). */
    fun isLinkedProfile(route: String?): Boolean =
        route?.startsWith("profile/") == true || (route == "profile" && profileViaLink)

    // The sidebar page that counts as open (a contributor's profile or the Contribute page belong to the page they
    // were opened from). Used for the highlighted row and for clearing that row's pill.
    val navRoute = when {
        isLinkedProfile(currentRoute) -> profileOrigin
        currentRoute?.startsWith("contribute/") == true -> contributeOrigin
        else -> currentRoute
    }

    // Seen counts, per account and page, kept on the phone. Opening a page marks everything waiting there as seen, so
    // its pill leaves the sidebar (only the sidebar: the page itself still shows its own numbers). The pill comes back
    // with the number of NEW things when more arrive than you have seen.
    val seenBadges = remember(account.accountId) {
        mutableStateMapOf<String, Int>().apply {
            rawBadges.keys.forEach { r ->
                val n = navPrefs.getInt("badge_seen_${account.accountId}_$r", 0)
                if (n > 0) put(r, n)
            }
        }
    }
    val badgeKnown = mapOf(
        "profile" to approvals.badgeLoaded,
        "discoveries" to (discoveryLoaded || "record_plant" !in permissions)
    )
    LaunchedEffect(navRoute, rawBadges, approvals.badgeLoaded, discoveryLoaded) {
        rawBadges.forEach { (route, n) ->
            val seen = seenBadges[route] ?: 0
            val next = when {
                route == navRoute -> n                                  // on that page right now: all of it is seen
                badgeKnown[route] ?: true -> minOf(seen, n)             // fewer waiting than seen: forget the extra
                else -> seen                                            // the server has not answered yet: keep as is
            }
            if (next != seen) {
                seenBadges[route] = next
                navPrefs.edit().putInt("badge_seen_${account.accountId}_$route", next).apply()
            }
        }
    }
    val navBadges = rawBadges.mapValues { (route, n) -> (n - (seenBadges[route] ?: 0)).coerceAtLeast(0) }

    fun go(route: String) {
        scope.launch { drawerState.close() }
        // Leaving a contributor's profile through the sidebar: close it (and forget the plant that was open) BEFORE
        // the page you were on is saved, so coming back to that page later shows the page, not the profile.
        libraryResume = null
        homeResume = null
        var guard = 0
        while (isLinkedProfile(navController.currentBackStackEntry?.destination?.route) && guard++ < 20) {
            if (!navController.popBackStack()) break
        }
        profileViaLink = false
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
        // Remember which page this started from (a profile opened from another profile keeps the first origin).
        val here = navController.currentBackStackEntry?.destination?.route
        if (!isLinkedProfile(here)) profileOrigin = here ?: "home"
        if (accountId == account.accountId) {
            profileViaLink = true
            navController.navigate("profile") { launchSingleTop = true }
        } else navController.navigate("profile/$accountId") { launchSingleTop = true }
    }

    /** The Contribute page of one plant. Plain navigate (no popUpTo), so Back returns to where the card was opened. */
    fun openContribute(plantId: String, plantName: String) {
        scope.launch { drawerState.close() }
        val here = navController.currentBackStackEntry?.destination?.route
        if (here?.startsWith("contribute/") != true) contributeOrigin = here ?: "home"
        contributeName = plantName
        navController.navigate("contribute/$plantId") { launchSingleTop = true }
    }

    /**
     * The change request form of one plant, with the description that was tapped already chosen. Same page and
     * same Back behaviour as Contribute; the route just says which of the two forms to show.
     */
    fun openRequestChange(plantId: String, plantName: String, descriptionId: String) {
        scope.launch { drawerState.close() }
        val here = navController.currentBackStackEntry?.destination?.route
        if (here?.startsWith("contribute/") != true) contributeOrigin = here ?: "home"
        contributeName = plantName
        navController.navigate("contribute/$plantId?change=1&desc=${android.net.Uri.encode(descriptionId)}") { launchSingleTop = true }
    }

    /** Back from the Contribute page: reopen the plant card on the Home or Library page it came from. */
    fun backFromContribute(plantId: String) {
        when (contributeOrigin) {
            "home" -> homeResume = plantId to contributeName
            "inventory" -> libraryResume = plantId to contributeName
        }
        if (!navController.popBackStack()) go("home")
    }

    // Lets the plant profile (a separate full-screen window) show the same sidebar.
    val appNav = remember(permissions) {
        AppNav(
            permissions,
            go = { route -> go(route) },
            signOut = { showSignOutDialog = true },
            contribute = { plantId, name -> openContribute(plantId, name) },
            requestChange = { plantId, name, descriptionId -> openRequestChange(plantId, name, descriptionId) }
        )
    }

    // The sidebar numbers: ask now, again whenever the page or the sidebar changes, and every 45 seconds.
    // Profile's number (pending approvals) is for EVERY signed-in account; only Discoveries needs record_plant.
    fun refreshNavBadges() {
        profileVm.refreshBadge()
        if ("record_plant" in permissions) refreshDiscoveryBadge() else discoveryBadge = 0
    }
    LaunchedEffect(account.accountId) { profileVm.resetApprovals() }
    LaunchedEffect(account.accountId, "record_plant" in permissions) {
        while (true) { refreshNavBadges(); delay(45_000) }
    }
    LaunchedEffect(currentRoute) { refreshNavBadges() }
    LaunchedEffect(drawerState.currentValue) {
        if (drawerState.currentValue == DrawerValue.Open) refreshNavBadges()
    }

    authUi.notice?.let { notice ->
        AlertDialog(
            onDismissRequest = { auth.consumeMessages() },
            title = { Text("Welcome to Plantellect") },
            text = { Text(notice) },
            confirmButton = { PlantTextButton({ auth.consumeMessages() }) { Text("OK") } }
        )
    }

    if (confirmRefresh) {
        AlertDialog(
            onDismissRequest = { confirmRefresh = false },
            title = { Text("Refresh this page?") },
            text = { Text("The page is loaded again and what you have typed or chosen here is cleared.") },
            confirmButton = { PlantTextButton({ confirmRefresh = false; doRefresh() }) { Text("Refresh") } },
            dismissButton = { PlantTextButton({ confirmRefresh = false }) { Text("Cancel") } }
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

    CompositionLocalProvider(LocalAppNav provides appNav, LocalNavBadges provides navBadges) {
    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            // Seven pages; Sign out is the icon at the top of the sheet.
            PlantellectDrawerSheet(
                permissions = permissions,
                // A contributor's profile counts as part of the page it was opened from (for example the Plant Library).
                currentRoute = navRoute,
                onGo = { route -> go(route) },
                onSignOut = { scope.launch { drawerState.close() }; showSignOutDialog = true }
            )
        }
    ) {
        Scaffold(
            containerColor = Color.Transparent,
            topBar = {
                // One bar for every page: Menu, then Back (only on a page you can go back from) in line with the
                // "Plantellect" title. There is no Refresh button: pull the page down from its top instead.
                val backEntry = navController.currentBackStackEntry
                PlantellectTopBar(
                    onMenu = { scope.launch { drawerState.open() } },
                    onBack = when {
                        currentRoute?.startsWith("contribute/") == true ->
                            ({ backFromContribute(backEntry?.arguments?.getString("plantId").orEmpty()) })
                        isLinkedProfile(currentRoute) -> ({ navController.popBackStack(); Unit })
                        else -> null
                    }
                )
            }
        ) { innerPadding ->
            // imePadding lifts every screen above the keyboard (edge-to-edge mode ignores adjustResize), and the
            // formatting bar of the description box being typed in is pinned right above the keyboard.
            val richToolbar = remember { RichToolbarHost() }
            CompositionLocalProvider(LocalRichToolbarHost provides richToolbar) {
                Column(Modifier.padding(innerPadding).consumeWindowInsets(innerPadding).imePadding()) {
                    Box(Modifier.weight(1f)) {
                // Pull the page down from its top to reload it (Home and the Library have their own, in place).
                val formPage = currentRoute == "scan" || currentRoute == "record" || currentRoute?.startsWith("contribute/") == true
                var pulling by remember { mutableStateOf(false) }
                LaunchedEffect(pulling) { if (pulling) { delay(700); pulling = false } }
                Refreshable(
                    refreshing = pulling,
                    onRefresh = {
                        // A page with a form asks first: reloading clears what was typed.
                        if (formPage) confirmRefresh = true else { pulling = true; doRefresh() }
                    },
                    enabled = currentRoute != "home" && currentRoute != "inventory",
                    modifier = Modifier.fillMaxSize()
                ) {
                CompositionLocalProvider(LocalRefreshNonce provides refreshNonce) {
                NavHost(navController, startDestination = "home", modifier = Modifier.fillMaxSize()) {
                    refreshable("home") {
                        HomeScreen(
                            onNavigateToScan = { go("scan") },
                            onNavigateToInventory = { go("inventory") },
                            vm = libraryVm,
                            onOpenBotanist = { id -> openPerson(id) },
                            resume = homeResume,
                            onResumeChange = { homeResume = it }
                        )
                    }
                    refreshable("inventory") {
                        PlantInventoryScreen(
                            vm = libraryVm,
                            onOpenBotanist = { id -> openPerson(id) },
                            resume = libraryResume,
                            onResumeChange = { libraryResume = it }
                        )
                    }
                    refreshable("scan") { ScanPlantScreen() }
                    refreshable("record") { RecordPlantScreen() }
                    // From a plant's profile, the plant is fixed. "Contribute" opens the contribution form; the "..." menu of a
                    // description opens the change request form (change=1) with that description (desc) already chosen.
                    refreshable(
                        "contribute/{plantId}?change={change}&desc={desc}",
                        arguments = listOf(
                            navArgument("plantId") { type = NavType.StringType },
                            navArgument("change") { type = NavType.StringType; defaultValue = "" },
                            navArgument("desc") { type = NavType.StringType; defaultValue = "" }
                        )
                    ) { entry ->
                        val plantId = entry.arguments?.getString("plantId").orEmpty()
                        val changeMode = entry.arguments?.getString("change") == "1"
                        val descId = entry.arguments?.getString("desc").orEmpty().ifBlank { null }
                        BackHandler { backFromContribute(plantId) }
                        // The app bar above already clears the status bar, so this page must not add that gap again.
                        Box(Modifier.fillMaxSize().consumeWindowInsets(WindowInsets.systemBars)) {
                            RecordPlantScreen(
                                fixedPlantId = plantId, fixedPlantName = contributeName,
                                changeMode = changeMode, changeDescriptionId = descId,
                                onBack = { backFromContribute(plantId) }
                            )
                        }
                    }
                    refreshable("discoveries") {
                        DiscoveriesScreen(
                            myAccountId = account.accountId,
                            onRecord = { go("record") },
                            // The reporter's name on each card opens their profile.
                            onOpenBotanist = { id -> openPerson(id) }
                        )
                    }
                    // Your own profile: identity, security, My reports, My contributions.
                    // Back shows only when it was opened by tapping your name, not from the sidebar.
                    refreshable("profile") {
                        ProfileHost(
                            account = account, profileVm = profileVm, libraryVm = libraryVm, baseUrl = baseUrl,
                            viewAccountId = null, onOpenPerson = { id -> openPerson(id) }
                        )
                    }
                    // Somebody else's profile: the same screen, read-only.
                    refreshable(
                        "profile/{accountId}",
                        arguments = listOf(navArgument("accountId") { type = NavType.StringType })
                    ) { entry ->
                        // Back (top bar) returns to wherever this profile was opened from (the plant, the list, a report).
                        ProfileHost(
                            account = account, profileVm = profileVm, libraryVm = libraryVm, baseUrl = baseUrl,
                            viewAccountId = entry.arguments?.getString("accountId"),
                            onOpenPerson = { id -> openPerson(id) }
                        )
                    }
                    refreshable("settings") { SettingsScreen(isAdmin = isAdmin) }
                }
                }
                }
                    }
                    RichToolbarBar(richToolbar)
                }
            }
        }
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
    // Goes up every time the plant page closes: votes and edits made there must show on the profile behind it.
    var refreshSignal by rememberSaveable { mutableStateOf(0) }
    LaunchedEffect(Unit) { if (resumePlant != null) { openPlant = resumePlant; resumePlant = null } }

    ProfileScreen(
        account = account,
        vm = profileVm,
        baseUrl = baseUrl,
        // AppShell only exists while signed in, so there is nothing to sign in to here.
        onSignIn = { },
        myAccountId = account.accountId,
        viewAccountId = viewAccountId,
        onOpenPlant = { id -> openPlant = id },
        refreshSignal = refreshSignal
    )

    openPlant?.let { id ->
        PlantProfileDialog(
            plantId = id,
            fallbackName = "Plant",
            heroUrl = null,
            vm = libraryVm,
            onOpenBotanist = { person -> resumePlant = openPlant; openPlant = null; onOpenPerson(person) },
            onClose = { openPlant = null; refreshSignal++ }
        )
    }
}


/** Goes up when the top bar's Refresh button is pressed. */
private val LocalRefreshNonce = compositionLocalOf { 0 }

/** Like composable(), but the page is built again (and so reads its data again) every time Refresh is pressed. */
private fun NavGraphBuilder.refreshable(
    route: String,
    arguments: List<NamedNavArgument> = emptyList(),
    content: @Composable (NavBackStackEntry) -> Unit
) = composable(route, arguments) { entry -> key(LocalRefreshNonce.current) { content(entry) } }
