package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.plantellect.mobileplantellect.R
import com.plantellect.mobileplantellect.ui.theme.LeafSmall

/*
 * The ONLY shared UI kit. Every screen is built from these, so there is no per-screen
 * copy of "card with rounded corners", "icon tile", "section title", and so on.
 * Icons come from material-icons-extended (IconBadge, chevrons); letters, the logo and Google Fonts otherwise.
 */

@Composable
internal fun PlantellectPage(scroll: Boolean = true, content: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.colorScheme
    Box(
        Modifier.fillMaxSize()
            .background(Brush.verticalGradient(listOf(c.primaryContainer.copy(alpha = .72f), c.background, c.background)))
            .systemBarsPadding()
    ) {
        Column(
            Modifier.fillMaxSize()
                .then(if (scroll) Modifier.verticalScroll(rememberScrollState()) else Modifier)
                .padding(horizontal = 20.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
            content = content
        )
    }
}

@Composable
internal fun LogoMark(size: Dp, modifier: Modifier = Modifier) {
    Image(
        painter = painterResource(R.drawable.plantellect_launcher_foreground),
        contentDescription = "Plantellect logo",
        modifier = modifier.size(size)
    )
}

/** Leaf-shaped tile with a letter. Used where a plant has no photo yet. */
@Composable
internal fun LeafBadge(text: String, size: Dp = 56.dp, modifier: Modifier = Modifier) {
    Box(
        modifier.size(size).clip(MaterialTheme.shapes.medium).background(MaterialTheme.colorScheme.primaryContainer),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text.trim().take(1).uppercase().ifEmpty { "P" },
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.primary
        )
    }
}

/** Same tile as [LeafBadge], with an icon (camera, plant library, ...) instead of a letter. */
@Composable
internal fun IconBadge(icon: ImageVector, size: Dp = 56.dp, modifier: Modifier = Modifier) {
    Box(
        modifier.size(size).clip(MaterialTheme.shapes.medium).background(MaterialTheme.colorScheme.primaryContainer),
        contentAlignment = Alignment.Center
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(size * 0.5f))
    }
}

/** Small filled leaf used as a bullet / "requirement met" marker. */
@Composable
internal fun LeafDot(active: Boolean, size: Dp = 12.dp) {
    val c = MaterialTheme.colorScheme
    Box(Modifier.size(size).clip(LeafSmall).background(if (active) c.primary else c.outlineVariant))
}

@Composable
internal fun PageHeading(eyebrow: String, title: String, subtitle: String) {
    val c = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(eyebrow.uppercase(), style = MaterialTheme.typography.labelMedium, color = c.primary)
        Text(title, style = MaterialTheme.typography.headlineMedium, color = c.onBackground)
        Text(subtitle, style = MaterialTheme.typography.bodyLarge, color = c.onBackground.copy(alpha = .72f))
    }
}

@Composable
internal fun SectionTitle(text: String) =
    Text(text, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground)

/** One card for the whole app; clickable when [onClick] is given. */
@Composable
internal fun PlantSurface(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    container: Color = MaterialTheme.colorScheme.surface,
    content: @Composable ColumnScope.() -> Unit
) {
    val shape = MaterialTheme.shapes.medium
    val colors = CardDefaults.cardColors(containerColor = container)
    val elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    if (onClick != null) Card(onClick = onClick, modifier = modifier, shape = shape, colors = colors, elevation = elevation, content = content)
    else Card(modifier = modifier, shape = shape, colors = colors, elevation = elevation, content = content)
}

/**
 * Badge + title + description (+ optional extras). Used for features, plants, profile rows.
 *
 * - Long titles / descriptions are cut with "…" ([descriptionLines] lines for the description).
 * - [leading] replaces the letter badge (e.g. a plant photo).
 * - [footer] goes under the text (e.g. a toxicity badge).
 */
@Composable
internal fun ListCard(
    badge: String,
    title: String,
    description: String? = null,
    tag: String? = null,
    warning: String? = null,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    showChevron: Boolean = onClick != null,
    descriptionLines: Int = 2,
    leading: (@Composable () -> Unit)? = null,
    footer: (@Composable () -> Unit)? = null
) {
    val c = MaterialTheme.colorScheme
    PlantSurface(modifier.fillMaxWidth(), onClick) {
        Row(
            Modifier.fillMaxWidth().padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            if (leading != null) leading() else LeafBadge(badge, 56.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    title, style = MaterialTheme.typography.titleMedium, color = c.onSurface,
                    maxLines = 1, overflow = TextOverflow.Ellipsis
                )
                if (!description.isNullOrBlank())
                    Text(
                        description, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant,
                        maxLines = descriptionLines, overflow = TextOverflow.Ellipsis
                    )
                if (!tag.isNullOrBlank())
                    Text(tag, style = MaterialTheme.typography.labelSmall, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!warning.isNullOrBlank())
                    Text(warning, style = MaterialTheme.typography.labelSmall, color = c.error, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (footer != null) {
                    Spacer(Modifier.height(2.dp))
                    footer()
                }
            }
            if (showChevron) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = c.onSurfaceVariant)
        }
    }
}

@Composable
internal fun EmptyState(title: String, message: String) {
    val c = MaterialTheme.colorScheme
    PlantSurface(Modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth().padding(26.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            LogoMark(48.dp)
            Text(title, style = MaterialTheme.typography.titleLarge, color = c.onSurface, textAlign = TextAlign.Center)
            Text(message, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant, textAlign = TextAlign.Center)
        }
    }
}

/** Settings-style row: title + description on the left, [trailing] (radio / switch) on the right. */
@Composable
internal fun OptionRow(title: String, description: String, modifier: Modifier = Modifier, trailing: @Composable () -> Unit) {
    Row(
        modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
            Text(description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        trailing()
    }
}