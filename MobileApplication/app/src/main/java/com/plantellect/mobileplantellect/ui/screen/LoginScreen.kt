package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
fun LoginScreen(onLogin: (String, String) -> Unit = { _, _ -> }) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val colors = MaterialTheme.colorScheme

    Box(Modifier.fillMaxSize().systemBarsPadding().padding(horizontal = 22.dp, vertical = 16.dp),
        contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            Surface(shape = RoundedCornerShape(26.dp), color = colors.primaryContainer) {
                Box(Modifier.size(88.dp), contentAlignment = Alignment.Center) {
                    Text("🌱", style = MaterialTheme.typography.displaySmall)
                }
            }
            Text("Plantellect", style = MaterialTheme.typography.headlineLarge, color = colors.primary, fontWeight = FontWeight.Bold)
            Text("A healthier home for your plant collection.", style = MaterialTheme.typography.bodyLarge,
                color = colors.onBackground.copy(alpha = .7f))
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(28.dp),
                colors = CardDefaults.cardColors(containerColor = colors.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
            ) {
                Column(Modifier.fillMaxWidth().padding(22.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text("Welcome back", style = MaterialTheme.typography.titleLarge)
                    Text("Sign in to continue to your green space.", style = MaterialTheme.typography.bodyMedium,
                        color = colors.onSurface.copy(alpha = .7f))
                    OutlinedTextField(
                        value = email, onValueChange = { email = it },
                        modifier = Modifier.fillMaxWidth(), label = { Text("Email or username") },
                        singleLine = true, shape = RoundedCornerShape(16.dp),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email)
                    )
                    OutlinedTextField(
                        value = password, onValueChange = { password = it },
                        modifier = Modifier.fillMaxWidth(), label = { Text("Password") },
                        singleLine = true, shape = RoundedCornerShape(16.dp),
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password)
                    )
                    Button(
                        onClick = { onLogin(email.trim(), password) },
                        modifier = Modifier.fillMaxWidth().height(54.dp),
                        shape = RoundedCornerShape(16.dp),
                        enabled = email.isNotBlank() && password.isNotBlank()
                    ) { Text("Sign in", style = MaterialTheme.typography.labelLarge) }
                }
            }
            Text("Discover more. Learn every day. Grow naturally.", style = MaterialTheme.typography.bodySmall,
                color = colors.onBackground.copy(alpha = .6f))
        }
    }
}
