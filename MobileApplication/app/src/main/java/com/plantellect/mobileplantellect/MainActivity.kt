package com.plantellect.mobileplantellect

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
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
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TileMode
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
import com.plantellect.mobileplantellect.ui.theme.MobilePlantellectTheme
import com.plantellect.mobileplantellect.viewmodel.AuthViewModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Built once in PlantellectApp (declare it in the manifest: android:name=".PlantellectApp").
        val factory = (application as PlantellectApp).container.viewModelFactory

        setContent {
            MobilePlantellectTheme {
                // Activity-scoped, so the login screen, the drawer and ProfileScreen all see the SAME login state.
                val auth: AuthViewModel = viewModel(factory = factory)
                val authState by auth.authState.collectAsState()

                GradientBackground {
                    when (val state = authState) {
                        // /me is still being checked on launch.
                        AuthState.Unknown -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                        // Also what the user returns to if the server drops the session.
                        AuthState.SignedOut -> LoginScreen { identifier, password ->
                            auth.login(identifier, password, rememberMe = false)
                        }
                        is AuthState.SignedIn -> AppShell(
                            auth = auth,
                            permissions = state.account.permissions
                        )
                    }
                }
            }
        }
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
private data class DrawerEntry(val label: String, val route: String, val requires: String? = null)

private val drawerEntries = listOf(
    DrawerEntry("Home", "home"),
    DrawerEntry("Plants", "inventory"),
    DrawerEntry("Scan a Plant", "scan"),
    DrawerEntry("Record a Plant", "record", requires = "record_plant"),
    DrawerEntry("Profile", "profile")
)

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

    fun go(route: String) {
        scope.launch { drawerState.close() }
        navController.navigate(route) {
            // One copy of each top-level screen; back returns to Home instead of stacking.
            popUpTo("home") { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                drawerContainerColor = MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.fillMaxWidth(0.5f).widthIn(max = 360.dp)
            ) {
                Text(
                    "Plantellect",
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(16.dp)
                )
                HorizontalDivider()

                drawerEntries
                    .filter { it.requires == null || it.requires in permissions }
                    .forEach { entry ->
                        NavigationDrawerItem(
                            label = {
                                Text(
                                    entry.label,
                                    style = MaterialTheme.typography.labelLarge,
                                    color = MaterialTheme.colorScheme.onSurface
                                )
                            },
                            selected = currentRoute == entry.route,
                            onClick = { go(entry.route) }
                        )
                    }

                HorizontalDivider()
                NavigationDrawerItem(
                    label = {
                        Text(
                            "Sign out",
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    },
                    selected = false,
                    onClick = {
                        scope.launch { drawerState.close() }
                        auth.logout()   // state flips to SignedOut and MainActivity shows LoginScreen
                    }
                )
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
                            color = MaterialTheme.colorScheme.onSurface
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
                composable("home") { HomeScreen() }
                // Each screen fetches its own ViewModel (see ui/AppViewModel.kt), so these calls keep
                // the screens' current signatures.
                composable("inventory") { PlantInventoryScreen() }
                composable("scan") { ScanPlantScreen() }
                composable("record") { RecordPlantScreen() }
                composable("profile") { ProfileScreen() }
            }
        }
    }
}
