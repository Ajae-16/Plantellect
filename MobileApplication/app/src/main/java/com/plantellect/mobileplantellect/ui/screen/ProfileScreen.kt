package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun ProfileScreen() {
    PlantellectPage {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            PageHeading("Personal space", "Your profile", "Manage your Plantellect experience.")
            Card(shape = androidx.compose.foundation.shape.RoundedCornerShape(24.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Row(Modifier.fillMaxWidth().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Surface(shape = androidx.compose.foundation.shape.CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                        Box(Modifier.size(64.dp), contentAlignment = androidx.compose.ui.Alignment.Center) {
                            Text("🙂", style = MaterialTheme.typography.headlineLarge)
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Plant lover", style = MaterialTheme.typography.titleLarge)
                        Text("Your account overview", style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = .7f))
                    }
                }
            }
            Text("Preferences", style = MaterialTheme.typography.titleLarge)
            FeatureCard("🔐", "Account & security", "Keep your sign-in details safe.")
            FeatureCard("🌿", "Plant interests", "Make your plant journey your own.")
            FeatureCard("ℹ️", "About Plantellect", "A companion for discovering and learning about plants.")
        }
    }
}
