package com.plantellect.mobileplantellect.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColorScheme = darkColorScheme(
    primary = GreenLight,
    onPrimary = GreenDark,
    secondary = Color(0xFFB9CCA0),
    tertiary = AccentPinkDark,
    background = DarkBackground,
    onBackground = DarkOnSurface,
    surface = Color(0xFF1A2210),
    onSurface = DarkOnSurface,
    primaryContainer = DarkPrimaryContainer,
    secondaryContainer = DarkSecondaryContainer,
    tertiaryContainer = DarkTertiaryContainer,
    onPrimaryContainer = DarkOnSurface
)

private val LightColorScheme = lightColorScheme(
    primary = GreenPrimary,
    onPrimary = Color.White,
    secondary = Color(0xFF5A6B45),
    tertiary = AccentPink,
    background = LightBackground,
    onBackground = LightOnSurface,
    surface = Color.White,
    onSurface = LightOnSurface,
    primaryContainer = LightPrimaryContainer,
    secondaryContainer = LightSecondaryContainer,
    tertiaryContainer = LightTertiaryContainer,
    onPrimaryContainer = LightOnSurface
)

@Composable
fun MobilePlantellectTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme,
        typography = Typography,
        content = content
    )
}