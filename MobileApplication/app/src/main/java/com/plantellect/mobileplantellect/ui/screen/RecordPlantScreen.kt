package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun RecordPlantScreen() {
    var plantName by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var watering by remember { mutableStateOf("Not recorded") }
    PlantellectPage {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            PageHeading("Plant journal", "Record a plant", "Keep simple notes about your plant's growth and care.")
            Card(shape = RoundedCornerShape(24.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    OutlinedTextField(value = plantName, onValueChange = { plantName = it },
                        modifier = Modifier.fillMaxWidth(), label = { Text("Plant name") }, singleLine = true,
                        shape = RoundedCornerShape(16.dp))
                    Text("Watering status", style = MaterialTheme.typography.titleMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("Watered", "Needs water", "Not recorded").forEach { option ->
                            FilterChip(selected = watering == option, onClick = { watering = option }, label = { Text(option) })
                        }
                    }
                    OutlinedTextField(value = notes, onValueChange = { notes = it },
                        modifier = Modifier.fillMaxWidth(), label = { Text("Growth notes") },
                        placeholder = { Text("Add observations or care notes…") },
                        minLines = 3, shape = RoundedCornerShape(16.dp))
                    Button(onClick = { }, modifier = Modifier.fillMaxWidth().height(52.dp),
                        enabled = plantName.isNotBlank(), shape = RoundedCornerShape(16.dp)) {
                        Text("Save record")
                    }
                    Text("This screen is a UI starter; connect Save record to your repository to persist entries.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .65f))
                }
            }
        }
    }
}
