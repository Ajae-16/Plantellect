package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import kotlinx.coroutines.launch
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
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

/**
 * THE background of the app: a soft green wash at the top fading into the page color. The app shell draws it once
 * behind every screen, and the plant profile (its own window) draws it too, so every page looks like one app.
 */
@Composable
internal fun Modifier.plantBackdrop(): Modifier {
    val c = MaterialTheme.colorScheme
    return this.background(c.background)
        .background(Brush.verticalGradient(listOf(c.primaryContainer.copy(alpha = .72f), c.background, c.background)))
}

/** A screen's page: scrolls, with the app's padding. The background comes from the app shell, not from here. */
@Composable
internal fun PlantellectPage(scroll: Boolean = true, compact: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    Box(Modifier.fillMaxSize().systemBarsPadding()) {
        Column(
            Modifier.fillMaxSize()
                .then(if (scroll) Modifier.verticalScroll(rememberScrollState()) else Modifier)
                // compact: a page that already has a Back bar above it needs less air around the content.
                .padding(horizontal = if (compact) 12.dp else 20.dp, vertical = if (compact) 4.dp else 10.dp),
            verticalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 14.dp),
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
internal fun PageHeading(eyebrow: String?, title: String, subtitle: String) {
    val c = MaterialTheme.colorScheme
    // Short heading: small eyebrow, one-line title, a two-line subtitle (it used to take a quarter of the screen).
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (eyebrow != null) Text(eyebrow.uppercase(), style = MaterialTheme.typography.labelSmall, color = c.primary)
        Text(
            title, style = MaterialTheme.typography.headlineSmall, color = c.onBackground,
            maxLines = 1, overflow = TextOverflow.Ellipsis
        )
        Text(
            subtitle, style = MaterialTheme.typography.bodyMedium, color = c.onBackground.copy(alpha = .72f),
            maxLines = 2, overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
internal fun SectionTitle(text: String) =
    Text(text, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground)

/**
 * A section whose title is a tap target that shows or hides its card (Settings uses it for Appearance and
 * Typography). [summary] says what is currently chosen while the section is closed.
 */
@Composable
internal fun FoldSection(
    title: String,
    summary: String,
    initiallyExpanded: Boolean = false,
    content: @Composable ColumnScope.() -> Unit
) {
    val c = MaterialTheme.colorScheme
    var expanded by rememberSaveable(title) { mutableStateOf(initiallyExpanded) }
    val arrowRotation by animateFloatAsState(if (expanded) 180f else 0f, label = "sectionArrow")
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            Modifier.fillMaxWidth()
                .clip(MaterialTheme.shapes.small)
                .clickable(onClickLabel = if (expanded) "Collapse $title" else "Expand $title", role = Role.Button) { expanded = !expanded }
                .padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                SectionTitle(title)
                if (!expanded) Text(summary, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
            }
            Icon(
                Icons.Filled.KeyboardArrowDown,
                contentDescription = if (expanded) "Collapse" else "Expand",
                tint = c.primary,
                modifier = Modifier.rotate(arrowRotation)
            )
        }
        AnimatedVisibility(expanded) {
            PlantSurface(Modifier.fillMaxWidth(), content = content)
        }
    }
}

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
// ---------------------------------------------------------------------------
// Rows that scroll sideways, with an arrow on the edge that has more out of view
// ---------------------------------------------------------------------------

/** A small round arrow on the left or right edge. Tap it to scroll that way. */
@Composable
private fun BoxScope.EdgeArrow(start: Boolean, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        shape = androidx.compose.foundation.shape.CircleShape,
        color = c.surface.copy(alpha = 0.92f),
        shadowElevation = 3.dp,
        modifier = Modifier.align(if (start) Alignment.CenterStart else Alignment.CenterEnd).padding(horizontal = 2.dp).size(28.dp)
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                if (start) Icons.AutoMirrored.Filled.KeyboardArrowLeft else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = if (start) "Scroll left" else "Scroll right",
                tint = c.primary, modifier = Modifier.size(20.dp)
            )
        }
    }
}

/** A row that scrolls sideways and shows an arrow on each edge while something is hidden past it. */
@Composable
internal fun HScroll(
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(0.dp),
    spacing: Dp = 8.dp,
    content: @Composable RowScope.() -> Unit
) {
    val state = rememberScrollState()
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val step = with(androidx.compose.ui.platform.LocalDensity.current) { 220.dp.toPx() }
    Box(modifier) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(state).padding(contentPadding),
            horizontalArrangement = Arrangement.spacedBy(spacing),
            content = content
        )
        if (state.canScrollBackward) EdgeArrow(true) { scope.launch { state.animateScrollBy(-step) } }
        if (state.canScrollForward) EdgeArrow(false) { scope.launch { state.animateScrollBy(step) } }
    }
}

/** Tabs that scroll sideways with arrows for the tabs that are out of view. The picked tab scrolls into view. */
@Composable
internal fun ScrollableTabStrip(labels: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val c = MaterialTheme.colorScheme
    val state = rememberScrollState()
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val step = with(androidx.compose.ui.platform.LocalDensity.current) { 180.dp.toPx() }
    Box(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().horizontalScroll(state)) {
            labels.forEachIndexed { i, label ->
                val on = i == selected
                // Height grows with the font size; the underline hugs the bottom of the tab.
                Column(
                    Modifier.clickable { onSelect(i) }.defaultMinSize(minHeight = 48.dp),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center
                ) {
                    Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), contentAlignment = Alignment.Center) {
                        Text(
                            label, maxLines = 1, style = MaterialTheme.typography.titleSmall,
                            color = if (on) c.primary else c.onSurfaceVariant
                        )
                    }
                    Box(Modifier.height(3.dp).fillMaxWidth().background(if (on) c.primary else Color.Transparent))
                }
            }
        }
        if (state.canScrollBackward) EdgeArrow(true) { scope.launch { state.animateScrollBy(-step) } }
        if (state.canScrollForward) EdgeArrow(false) { scope.launch { state.animateScrollBy(step) } }
    }
}

/**
 * Limits how much the phone's font size can grow the text INSIDE [content]. For cards that have a fixed size
 * (the Library grid, the Home slider): everywhere else text follows the phone's setting fully.
 */
@Composable
internal fun CappedFontScale(max: Float = 1.15f, content: @Composable () -> Unit) {
    val d = androidx.compose.ui.platform.LocalDensity.current
    androidx.compose.runtime.CompositionLocalProvider(
        androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(d.density, d.fontScale.coerceAtMost(max)),
        content = content
    )
}
