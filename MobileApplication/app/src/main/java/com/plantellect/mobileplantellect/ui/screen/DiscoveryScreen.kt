package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun DiscoveryScreen() {
    var search by remember { mutableStateOf("") }
    PlantellectPage {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            PageHeading("Plant library", "Discover plants", "Find inspiration and learn about the plants around you.")
            OutlinedTextField(
                value = search, onValueChange = { search = it },
                modifier = Modifier.fillMaxWidth(), singleLine = true,
                shape = androidx.compose.foundation.shape.RoundedCornerShape(18.dp),
                label = { Text("Search plants") },
                placeholder = { Text("Try a plant name") }
            )
            Surface(shape = androidx.compose.foundation.shape.RoundedCornerShape(22.dp),
                color = MaterialTheme.colorScheme.primaryContainer) {
                Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("🌼  A little plant knowledge goes a long way", style = MaterialTheme.typography.titleMedium)
                    Text("Explore plant details and use what you learn to care for your collection.",
                        style = MaterialTheme.typography.bodyMedium)
                }
            }
            Text("Browse", style = MaterialTheme.typography.titleLarge)
            FeatureCard("🌿", "Plant encyclopedia", "Explore species and their characteristics.")
            FeatureCard("🌱", "Beginner-friendly plants", "Start with plants that are easy to learn about.")
            FeatureCard("🍃", "Plant care basics", "Learn about light, water, and healthy growth.")
            if (search.isNotBlank()) {
                Text("Search is ready for: $search", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = .65f))
            }
        }
    }
}
