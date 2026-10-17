package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun PlantInventoryScreen() {
    PlantellectPage {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            PageHeading("Your collection", "My plants", "All your saved plants, in one place.")
            FeatureCard("🪴", "Your collection", "Plants you save will appear here.")
            EmptyState("🌱", "Your collection is waiting to grow", "Scan a plant or add one to start building your personal plant library.")
            androidx.compose.material3.Text("Tip: Use clear photos and keep notes about where and when you found a plant.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onBackground.copy(alpha = .7f))
        }
    }
}
