package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocalFlorist
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.plantellect.mobileplantellect.ui.theme.ColorTheme
import com.plantellect.mobileplantellect.ui.theme.GreenLight
import com.plantellect.mobileplantellect.ui.theme.GreenPrimary
import com.plantellect.mobileplantellect.ui.theme.MobilePlantellectTheme
import com.plantellect.mobileplantellect.ui.theme.TypeCombo
import com.plantellect.mobileplantellect.ui.theme.extraColors
import com.plantellect.mobileplantellect.ui.theme.generatedScheme

/**
 * Settings > Appearance > Color theme: a small mock screen in LIGHT and one in DARK, side by side, drawn with the
 * theme that is picked. It is rebuilt from [theme] every time the choice changes, so the person sees both modes
 * before (and after) choosing, whatever the phone itself is set to.
 */
@Composable
internal fun ColorThemePreview(theme: ColorTheme, typeCombo: TypeCombo, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        MiniScreen("Light", dark = false, theme = theme, typeCombo = typeCombo, modifier = Modifier.weight(1f))
        MiniScreen("Dark", dark = true, theme = theme, typeCombo = typeCombo, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun MiniScreen(label: String, dark: Boolean, theme: ColorTheme, typeCombo: TypeCombo, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        // The label uses the app's current colors; only the box below is drawn in the previewed theme.
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        MobilePlantellectTheme(darkTheme = dark, dynamicColor = false, typeCombo = typeCombo, colorTheme = theme) {
            val c = MaterialTheme.colorScheme
            val x = MaterialTheme.extraColors
            Surface(
                shape = RoundedCornerShape(16.dp), color = c.background,
                border = BorderStroke(1.dp, c.outlineVariant), modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // top bar
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.size(14.dp).clip(CircleShape).background(c.primary))
                        Text("Plantellect", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = c.onSurface, maxLines = 1)
                    }
                    // a plant card
                    Surface(
                        shape = RoundedCornerShape(12.dp), color = c.surface,
                        border = BorderStroke(1.dp, c.outlineVariant), modifier = Modifier.fillMaxWidth()
                    ) {
                        Column {
                            Box(
                                Modifier.fillMaxWidth().height(46.dp)
                                    .background(Brush.linearGradient(listOf(x.photoBackdropStart, x.photoBackdropEnd))),
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(Icons.Filled.LocalFlorist, null, tint = x.forest, modifier = Modifier.size(22.dp))
                            }
                            Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text("Aloe vera", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.onSurface, maxLines = 1)
                                Text("Aloe barbadensis", fontSize = 9.sp, fontStyle = FontStyle.Italic, color = c.onSurfaceVariant, maxLines = 1)
                                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Surface(shape = RoundedCornerShape(50), color = c.secondaryContainer) {
                                        Text("Herb", Modifier.padding(horizontal = 7.dp, vertical = 2.dp), fontSize = 9.sp, color = c.onSurface)
                                    }
                                    Surface(shape = RoundedCornerShape(50), color = c.primaryContainer) {
                                        Text("Safe", Modifier.padding(horizontal = 7.dp, vertical = 2.dp), fontSize = 9.sp, color = c.onPrimaryContainer)
                                    }
                                }
                            }
                        }
                    }
                    // a button and a link-colored line
                    Surface(shape = RoundedCornerShape(50), color = c.primary, modifier = Modifier.fillMaxWidth()) {
                        Text(
                            "Contribute", Modifier.padding(vertical = 5.dp), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                            color = c.onPrimary, maxLines = 1, textAlign = androidx.compose.ui.text.style.TextAlign.Center
                        )
                    }
                    Text("Edited by Maria", fontSize = 9.sp, color = c.primary, maxLines = 1)
                }
            }
        }
    }
}

/** Two dots: the theme's main color in light and in dark mode. */
@Composable
internal fun ThemeSwatch(theme: ColorTheme) {
    val h = theme.hue
    val light = if (h == null) GreenPrimary else generatedScheme(h, false).primary
    val dark = if (h == null) GreenLight else generatedScheme(h, true).primary
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(22.dp).clip(CircleShape).background(light))
        Surface(shape = CircleShape, color = dark, border = BorderStroke(2.dp, MaterialTheme.colorScheme.surface), modifier = Modifier.size(22.dp)) {}
    }
}
