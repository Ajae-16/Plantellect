package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
fun HomeScreen() {
    PlantellectPage {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("PLANTELLECT", style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                    Text("Grow with confidence.", style = MaterialTheme.typography.headlineMedium)
                }
                Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                    androidx.compose.foundation.layout.Box(Modifier.size(54.dp), contentAlignment = androidx.compose.ui.Alignment.Center) {
                        Text("🌿", style = MaterialTheme.typography.headlineMedium)
                    }
                }
            }
            Card(
                shape = RoundedCornerShape(28.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary)
            ) {
                Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Your little green space", style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onPrimary)
                    Text("Identify plants, keep your collection organized, and learn as you grow.",
                        style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onPrimary.copy(alpha = .88f))
                    Text("🌱  Discover • Identify • Care", style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onPrimary)
                }
            }
            Text("Explore Plantellect", style = MaterialTheme.typography.titleLarge)
            FeatureCard("📷", "Identify a plant", "Scan a clear photo to start discovering.")
            FeatureCard("🪴", "My plant collection", "Keep your saved plants together.")
            FeatureCard("📚", "Plant discovery", "Explore plant information and characteristics.")
        }
    }
}
