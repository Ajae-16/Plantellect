package com.plantellect.mobileplantellect

import android.R
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
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.plantellect.mobileplantellect.ui.screen.HomeScreen
import com.plantellect.mobileplantellect.ui.screen.PlantInventoryScreen
import com.plantellect.mobileplantellect.ui.screen.ProfileScreen
import com.plantellect.mobileplantellect.ui.screen.RecordPlantScreen
import com.plantellect.mobileplantellect.ui.screen.ScanPlantScreen
import com.plantellect.mobileplantellect.ui.theme.MobilePlantellectTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    @OptIn(ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MobilePlantellectTheme {
                // Background
                Box(modifier = Modifier.fillMaxSize().background(brush = Brush.linearGradient(colors = listOf(
                    MaterialTheme.colorScheme.primaryContainer ,
                    MaterialTheme.colorScheme.secondaryContainer,
                    MaterialTheme.colorScheme.tertiaryContainer),
                    start = Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY),
                    end = Offset.Zero,
                    tileMode = TileMode.Clamp
                )))
                // Navigation Controller
                val navController = androidx.navigation.compose.rememberNavController()
                // Drawer State (to open/close the sidebar)
                val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
                val scope = rememberCoroutineScope()

                // The Sidebar Wrapper
                ModalNavigationDrawer(
                    drawerState = drawerState,
                    drawerContent = {
                        ModalDrawerSheet(drawerContainerColor =
                            MaterialTheme.colorScheme.primaryContainer,
                            modifier = Modifier.fillMaxWidth(0.5f).widthIn(max = 360.dp)
                            )
                        {
                            Text(
                                "Plantellect",
                                style = MaterialTheme.typography.headlineMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.padding(16.dp)
                            )
                            HorizontalDivider()

                            // Menu Item: Home (changed from Discovery)
                            NavigationDrawerItem(
                                label = { Text("Home",
                                    style = MaterialTheme.typography.labelLarge,
                                    color = MaterialTheme.colorScheme.onSurface) },
                                selected = false,
                                onClick = {
                                    scope.launch { drawerState.close() }
                                    navController.navigate("home")
                                }
                            )

                            // Menu Item: Plant Inventory
                            NavigationDrawerItem(
                                label = { Text("Plants",
                                    style = MaterialTheme.typography.labelLarge,
                                    color = MaterialTheme.colorScheme.onSurface) },
                                selected = false,
                                onClick = {
                                    scope.launch { drawerState.close() }
                                    navController.navigate("inventory")
                                }
                            )

                            // Menu Item: Scanning Plant
                            NavigationDrawerItem(
                                label = { Text("Scan a Plant",
                                    style = MaterialTheme.typography.labelLarge,
                                    color = MaterialTheme.colorScheme.onSurface) },
                                selected = false,
                                onClick = {
                                    scope.launch { drawerState.close() }
                                    navController.navigate("scan")
                                }
                            )
                            // Menu Item: Recording Plant
                            NavigationDrawerItem(
                                label = { Text("Record a Plant",
                                    style = MaterialTheme.typography.labelLarge,
                                    color = MaterialTheme.colorScheme.onSurface) },
                                selected = false,
                                onClick = {
                                    scope.launch { drawerState.close() }
                                    navController.navigate("record")
                                }
                            )
                            // Menu Item: Profile
                            NavigationDrawerItem(
                                label = { Text("Profile",
                                    style = MaterialTheme.typography.labelLarge,
                                    color = MaterialTheme.colorScheme.onSurface) },
                                selected = false,
                                onClick = {
                                    scope.launch { drawerState.close() }
                                    navController.navigate("profile")
                                }
                            )
                        }
                    }
                ) {
                    // The Screen Scaffold
                    Scaffold(
                        topBar = {
                            CenterAlignedTopAppBar(
                                title = { Text("Plantellect",
                                    style = MaterialTheme.typography.headlineMedium,
                                    color = MaterialTheme.colorScheme.onSurface) },
                                navigationIcon = {
                                    IconButton(onClick = { scope.launch { drawerState.open() } }) {
                                        Icon(Icons.Default.Menu, contentDescription = "Menu")
                                    }
                                }
                            )
                        }
                    ) { innerPadding ->
                        // The Content Swapper (NavHost)
                        NavHost(
                            navController = navController,
                            startDestination = "home",
                            modifier = Modifier.padding(innerPadding)
                        ) {
                            composable("home") { HomeScreen() }
                            composable("inventory") { PlantInventoryScreen() }
                            composable("scan") { ScanPlantScreen() }
                            composable("record") { RecordPlantScreen() }
                            composable("profile") { ProfileScreen() }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun Greeting(name: String, modifier: Modifier = Modifier) {
    Text(
        text = "Hello $name!",
        modifier = modifier,
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onBackground
    )
}

@Preview(showBackground = true)
@Composable
fun GreetingPreview() {
    MobilePlantellectTheme {
        Box(modifier = Modifier.fillMaxSize().background(brush = Brush.linearGradient(colors = listOf(
            MaterialTheme.colorScheme.primaryContainer ,
            MaterialTheme.colorScheme.secondaryContainer,
            MaterialTheme.colorScheme.tertiaryContainer),
            start = Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY),
            end = Offset(0f, 0f)
        )))
    }
}