package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

/*
 * THE button kit. Every button in the app is one of these four, so they all share the same leaf-shaped
 * corners, the same minimum height (a comfortable touch target) and the theme's label font.
 *
 *   PlantButton          the main action on a screen or card        (filled green)
 *   PlantTonalButton     a softer secondary action                   (light green)
 *   PlantOutlinedButton  an alternative / "other" action             (green outline)
 *   PlantTextButton      the quietest action: Back, Cancel, Dismiss  (text only)
 *
 * They take the same arguments as the Material buttons they wrap, so a screen only changes the name.
 */

private val MinButtonHeight = 48.dp

@Composable
internal fun PlantButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = MaterialTheme.shapes.small,
    colors: ButtonColors = ButtonDefaults.buttonColors(),
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    content: @Composable RowScope.() -> Unit
) = Button(
    onClick = onClick, modifier = modifier.heightIn(min = MinButtonHeight), enabled = enabled, shape = shape,
    colors = colors, contentPadding = contentPadding, content = content
)

@Composable
internal fun PlantTonalButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = MaterialTheme.shapes.small,
    colors: ButtonColors = ButtonDefaults.filledTonalButtonColors(),
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    content: @Composable RowScope.() -> Unit
) = FilledTonalButton(
    onClick = onClick, modifier = modifier.heightIn(min = MinButtonHeight), enabled = enabled, shape = shape,
    colors = colors, contentPadding = contentPadding, content = content
)

@Composable
internal fun PlantOutlinedButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = MaterialTheme.shapes.small,
    colors: ButtonColors = ButtonDefaults.outlinedButtonColors(),
    border: BorderStroke? = null,
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    content: @Composable RowScope.() -> Unit
) {
    val c = MaterialTheme.colorScheme
    OutlinedButton(
        onClick = onClick, modifier = modifier.heightIn(min = MinButtonHeight), enabled = enabled, shape = shape,
        colors = colors,
        border = border ?: BorderStroke(1.dp, if (enabled) c.primary.copy(alpha = 0.6f) else c.onSurface.copy(alpha = 0.12f)),
        contentPadding = contentPadding, content = content
    )
}

@Composable
internal fun PlantTextButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = MaterialTheme.shapes.small,
    colors: ButtonColors = ButtonDefaults.textButtonColors(),
    contentPadding: PaddingValues = ButtonDefaults.TextButtonContentPadding,
    content: @Composable RowScope.() -> Unit
) = TextButton(
    onClick = onClick, modifier = modifier.heightIn(min = MinButtonHeight), enabled = enabled, shape = shape,
    colors = colors, contentPadding = contentPadding, content = content
)

/**
 * THE Back button: every screen that can go back uses this one, so they all look and feel the same.
 * A soft green pill with an arrow, never smaller than a comfortable touch target.
 */
@Composable
internal fun AppBackButton(onClick: () -> Unit, modifier: Modifier = Modifier, label: String = "Back") {
    val c = MaterialTheme.colorScheme
    androidx.compose.material3.Surface(
        onClick = onClick,
        modifier = modifier.heightIn(min = 36.dp),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(50),
        color = c.primaryContainer,
        contentColor = c.onPrimaryContainer
    ) {
        androidx.compose.foundation.layout.Row(
            Modifier.padding(start = 10.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(6.dp)
        ) {
            androidx.compose.material3.Icon(
                androidx.compose.material.icons.Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = null, modifier = Modifier.size(18.dp)
            )
            androidx.compose.material3.Text(
                label, style = MaterialTheme.typography.labelLarge,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, maxLines = 1
            )
        }
    }
}
