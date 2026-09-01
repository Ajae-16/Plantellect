package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.TileMode

@Composable
fun ProfileScreen(){
    // Background
    Box(modifier = Modifier.fillMaxSize().background(brush = Brush.linearGradient(colors = listOf(
        MaterialTheme.colorScheme.primaryContainer ,
        MaterialTheme.colorScheme.secondaryContainer,
        MaterialTheme.colorScheme.tertiaryContainer),
        start = Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY),
        end = Offset.Zero,
        tileMode = TileMode.Clamp
    )))
    Text(text = "Profile Screen", style = MaterialTheme.typography.bodyLarge)
}