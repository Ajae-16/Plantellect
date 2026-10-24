package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

@Composable
internal fun PlantellectPage(content: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.colorScheme
    Box(
        Modifier.fillMaxSize().background(
            Brush.verticalGradient(listOf(c.primaryContainer.copy(alpha = 0.72f), c.background, c.background))
        ).systemBarsPadding()
    ) {
        Column(
            Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
            content = content
        )
    }
}

@Composable
internal fun PageHeading(eyebrow: String, title: String, subtitle: String) {
    val c = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(eyebrow.uppercase(), style = MaterialTheme.typography.labelMedium,
            color = c.primary, fontWeight = FontWeight.Bold)
        Text(title, style = MaterialTheme.typography.headlineMedium, color = c.onBackground)
        Text(subtitle, style = MaterialTheme.typography.bodyLarge, color = c.onBackground.copy(alpha = .72f))
    }
}

@Composable
internal fun FeatureCard(emoji: String,
                         title: String,
                         description: String,
                         modifier: Modifier = Modifier,
                         onClick:(()-> Unit)? = null) {
    val c = MaterialTheme.colorScheme
    val cardContent: @Composable ColumnScope.() -> Unit = {
        Row(
            Modifier.fillMaxWidth().padding(18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Surface(shape = RoundedCornerShape(16.dp), color = c.primaryContainer) {
                Box(Modifier.size(54.dp), contentAlignment = Alignment.Center) {
                    Text(emoji, style = MaterialTheme.typography.headlineSmall)
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = c.onSurface)
                Text(description, style = MaterialTheme.typography.bodyMedium, color = c.onSurface.copy(alpha = .7f))
            }
        }
    }
    if (onClick != null) {
        Card(
            onClick = onClick,
            modifier = modifier,
            shape = RoundedCornerShape(22.dp),
            colors = CardDefaults.cardColors(containerColor = c.surface),
            elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
            content = cardContent
        )
    } else {
        Card(
            modifier = modifier,
            shape = RoundedCornerShape(22.dp),
            colors = CardDefaults.cardColors(containerColor = c.surface),
            elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
            content = cardContent
        )
    }
}

@Composable
internal fun EmptyState(emoji: String, title: String, message: String) {
    val c = MaterialTheme.colorScheme
    Card(
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = c.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            Modifier.fillMaxWidth().padding(26.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(emoji, style = MaterialTheme.typography.displaySmall)
            Text(title, style = MaterialTheme.typography.titleLarge, color = c.onSurface, textAlign = TextAlign.Center)
            Text(message, style = MaterialTheme.typography.bodyMedium, color = c.onSurface.copy(alpha = .7f), textAlign = TextAlign.Center)
        }
    }
}
