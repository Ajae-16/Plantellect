package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun DiscoveryScreen() {
    var search by remember { mutableStateOf("") }
    val c = MaterialTheme.colorScheme

    PlantellectPage {
        PageHeading("Plant library", "Discover plants", "Find inspiration and learn about the plants around you.")

        OutlinedTextField(
            value = search, onValueChange = { search = it },
            modifier = Modifier.fillMaxWidth(), singleLine = true,
            shape = MaterialTheme.shapes.small,
            label = { Text("Search plants") },
            placeholder = { Text("Try a plant name") }
        )

        PlantSurface(Modifier.fillMaxWidth(), container = c.primaryContainer) {
            Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("A little plant knowledge goes a long way", style = MaterialTheme.typography.titleMedium, color = c.onSurface)
                Text(
                    "Explore plant details and use what you learn to care for your collection.",
                    style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
                )
            }
        }

        SectionTitle("Browse")
        ListCard("E", "Plant encyclopedia", "Explore species and their characteristics.")
        ListCard("B", "Beginner-friendly plants", "Start with plants that are easy to learn about.")
        ListCard("C", "Plant care basics", "Learn about light, water, and healthy growth.")

        if (search.isNotBlank()) {
            Text("Search is ready for: $search", style = MaterialTheme.typography.bodySmall, color = c.onBackground.copy(alpha = .65f))
        }
    }
}