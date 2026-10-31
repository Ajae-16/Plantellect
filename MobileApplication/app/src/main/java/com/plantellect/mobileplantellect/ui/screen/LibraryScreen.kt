package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.ui.theme.LightOnSurface
import com.plantellect.mobileplantellect.ui.theme.ScanWarn
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import com.plantellect.mobileplantellect.viewmodel.SearchBy
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.roundToInt

/**
 * Plant library: search (from the first letter), common / scientific filter, type filter,
 * two-column grid, 10 cards per page with Previous / Next, pull to refresh.
 * The name / type filters sit behind a "Filters" drop down that shows or hides them.
 */
@Composable
fun LibraryScreen(vm: LibraryViewModel) {
    val ui by vm.ui.collectAsState()
    val gridState = rememberLazyGridState()
    var open by remember { mutableStateOf<Pair<String, String>?>(null) }

    // false = filters hidden, true = filters shown. Change to true to start expanded.
    var filtersOpen by remember { mutableStateOf(false) }
    val arrowRotation by animateFloatAsState(if (filtersOpen) 180f else 0f, label = "filtersArrow")

    // Jump back to the first card whenever the page (or the results) change.
    LaunchedEffect(ui.page, ui.total) { gridState.scrollToItem(0) }

    Column(Modifier.fillMaxSize()) {
        // Search box: always visible
        OutlinedTextField(
            value = ui.query, onValueChange = vm::setQuery,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            singleLine = true, shape = RoundedCornerShape(16.dp),
            placeholder = {
                Text(
                    when (ui.searchBy) {
                        SearchBy.SCIENTIFIC -> "Search scientific name"
                        SearchBy.COMMON -> "Search common name"
                        SearchBy.ALL -> "Search plants"
                    }
                )
            },
            leadingIcon = { Icon(Icons.Filled.Search, null) },
            trailingIcon = {
                if (ui.query.isNotEmpty()) IconButton({ vm.setQuery("") }) { Icon(Icons.Filled.Clear, "Clear") }
            }
        )

        // Drop down header: tap to show / hide the filters
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { filtersOpen = !filtersOpen }
                .padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "Filters",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface
            )
            // While collapsed, show what is currently applied
            if (!filtersOpen) {
                val summary = buildList {
                    add(ui.searchBy.label)
                    ui.typeName?.let { add(it.replaceFirstChar { c -> c.uppercase() }) }
                }.joinToString(" · ")
                Text(
                    summary,
                    Modifier.padding(start = 8.dp).weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis
                )
            } else {
                Spacer(Modifier.weight(1f))
            }
            Icon(
                Icons.Filled.ArrowDropDown,
                contentDescription = if (filtersOpen) "Hide filters" else "Show filters",
                modifier = Modifier.graphicsLayer { rotationZ = arrowRotation }
            )
        }

        AnimatedVisibility(
            visible = filtersOpen,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut()
        ) {
            Column {
                // Search by: all / common / scientific
                Row(
                    Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    SearchBy.entries.forEach {
                        FilterChip(ui.searchBy == it, { vm.setSearchBy(it) }, label = { Text(it.label) })
                    }
                }

                // Plant type filter
                if (ui.types.isNotEmpty()) {
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        FilterChip(ui.typeName == null, { vm.setType(null) }, label = { Text("All types") })
                        ui.types.forEach { t ->
                            FilterChip(
                                selected = ui.typeName == t.typeName,
                                onClick = { vm.setType(if (ui.typeName == t.typeName) null else t.typeName) },
                                label = { Text(t.typeName.replaceFirstChar { it.uppercase() }) }
                            )
                        }
                    }
                }
            }
        }

        Refreshable(refreshing = ui.loading && ui.items.isEmpty(), onRefresh = { vm.reload() }, modifier = Modifier.weight(1f)) {
            LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                modifier = Modifier.fillMaxSize(),
                state = gridState,
                contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                if (ui.items.isEmpty() && !ui.loading) {
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        Text(
                            ui.error ?: "No plants found.",
                            color = if (ui.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                items(ui.items, key = { it.cardId }) { p ->
                    LibraryPlantCard(
                        id = p.cardId,
                        name = p.cardName,
                        photoUrl = vm.imageUrl(p),
                        listToxicity = p.cardToxicity,
                        vm = vm,
                        // addedAt = p.<creation date field>,   // wire the date here
                        onClick = { open = p.cardId to p.cardName }
                    )
                }
            }
        }

        // Pagination bar: only when there is more than one page
        if (ui.pageCount > 1) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedButton(onClick = vm::prevPage, enabled = ui.hasPrev && !ui.loading) { Text("Previous") }
                Text(
                    "Page ${ui.page} of ${ui.pageCount}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedButton(onClick = vm::nextPage, enabled = ui.hasNext && !ui.loading) { Text("Next") }
            }
        }
    }

    open?.let { (id, name) ->
        PlantProfileDialog(id, name, heroUrl = null, vm = vm, onClose = { open = null })
    }
}

// ---------------------------------------------------------------------------
// The Library card: fixed-size grid version of the web card (.plant-grid .plant-card)
// ---------------------------------------------------------------------------

internal val ForestGreen = Color(0xFF2E6417)
internal val DarkForestGreen = Color(0xFF234C11)

/** Every Library card is exactly this tall, whatever its content. */
private val LibraryCardHeight = 236.dp

/**
 * Same order as the web card (image, name, chips, date, note), but every part has a fixed slot,
 * so all cards have the same size: 90 dp image, one-line name, a two-line chip slot,
 * a date slot, and a 2-line note. Anything longer is clipped or cut with "…".
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LibraryPlantCard(
    id: String,
    name: String,
    photoUrl: String?,
    listToxicity: String?,
    vm: LibraryViewModel,
    modifier: Modifier = Modifier,
    addedAt: String? = null,
    onClick: () -> Unit
) {
    val c = MaterialTheme.colorScheme
    val info = rememberCardInfo(id, vm, null, listToxicity)
    val added = formatAdded(addedAt)

    Card(
        modifier.fillMaxWidth().height(LibraryCardHeight).clickable(onClick = onClick),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = c.surface),
        border = BorderStroke(1.dp, ForestGreen.copy(alpha = 0.12f)),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(Modifier.fillMaxSize()) {
            // image box: fixed 90 dp, soft green gradient behind the photo
            Box(
                Modifier.fillMaxWidth().height(90.dp)
                    .background(Brush.linearGradient(listOf(Color(0xFFDCEFD0), Color(0xFFB9DCA3))))
            ) {
                PlantCardPhoto(id, photoUrl, name, vm, Modifier.fillMaxSize())
            }

            // name: always one line
            Text(
                name.uppercase(),
                Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 8.dp, bottom = 4.dp),
                color = c.onSurface, fontSize = 13.sp, lineHeight = 16.sp,
                fontWeight = FontWeight.Bold, letterSpacing = 0.017.em,
                maxLines = 1, overflow = TextOverflow.Ellipsis
            )

            // chips: a fixed two-line slot (clipped), so wrapping never changes the card height
            FlowRow(
                Modifier.fillMaxWidth().height(40.dp).clipToBounds()
                    .padding(start = 10.dp, end = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                if (info.type.isNotBlank()) PlantTypeChip(info.type, compact = true)
                info.toxicity?.let { ToxicityChip(it, compact = true) }
            }

            // date: always reserves its slot
            Row(
                Modifier.fillMaxWidth().height(16.dp).padding(start = 10.dp, end = 10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (added != null) {
                    Icon(Icons.Filled.CalendarToday, null, Modifier.size(11.dp), tint = c.onSurfaceVariant)
                    Spacer(Modifier.width(3.dp))
                    Text(added, color = c.onSurfaceVariant, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }

            // note: label + 2-line text, fills whatever is left
            val harmful = info.toxicity != null && info.toxicity != "none"
            val label = if (harmful) "⚠ Watch out" else "Benefits"
            val text = if (harmful) "Handle with care." else info.benefits   // replaced by the recorded warning once the DTO field is wired

            Column(
                Modifier.fillMaxWidth().weight(1f).clipToBounds()
                    .padding(start = 10.dp, end = 10.dp, top = 2.dp)
            ) {
                Text(
                    label.uppercase(),
                    color = if (harmful) c.error else ForestGreen,
                    fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.06.em, maxLines = 1
                )
                Text(
                    if (text.isNullOrBlank()) "No details added yet." else text,
                    Modifier.padding(top = 1.dp).fillMaxWidth(),
                    color = when {
                        text.isNullOrBlank() -> c.outline
                        harmful -> c.error
                        else -> c.onSurfaceVariant
                    },
                    fontStyle = if (text.isNullOrBlank()) FontStyle.Italic else FontStyle.Normal,
                    fontSize = 11.sp, lineHeight = 14.sp,
                    maxLines = 2, overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

/** Plant type chip: green tint, thin green border (.plant-chip-type). [compact] = smaller text and padding. */
@Composable
fun PlantTypeChip(type: String, compact: Boolean = false) {
    Surface(
        shape = RoundedCornerShape(50),
        color = ForestGreen.copy(alpha = 0.10f),
        border = BorderStroke(1.dp, ForestGreen.copy(alpha = 0.25f))
    ) {
        Text(
            type.replaceFirstChar { it.uppercase() },
            Modifier.padding(horizontal = if (compact) 6.dp else 10.dp, vertical = if (compact) 2.dp else 4.dp),
            color = if (MaterialTheme.colorScheme.background.luminanceIsLight()) DarkForestGreen
            else MaterialTheme.colorScheme.onSurface,
            fontSize = if (compact) 10.sp else 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

private fun Color.luminanceIsLight(): Boolean = (red * 0.299f + green * 0.587f + blue * 0.114f) > 0.5f

/** Toxicity chip with the web labels and colours (.plant-chip-tox). [level] is any server value. */
@Composable
fun ToxicityChip(level: String, compact: Boolean = false) {
    val k = normalizeToxicity(level)
    val label = when (k) {
        "none" -> "Non-toxic"
        "low" -> "Low toxicity"
        "mild" -> "Mild toxicity"
        "moderate" -> "Moderate toxicity"
        "high" -> "High toxicity"
        "severe" -> "Severe toxicity"
        else -> k.replaceFirstChar { it.uppercase() } + " toxicity"
    }
    // background, text, border
    val (bg, fg, border) = when (k) {
        "none" -> Triple(Color(0xFFE6F4E1), Color(0xFF2E6417), Color(0xFFB9DCA3))
        "low", "mild" -> Triple(Color(0xFFFFF6D6), Color(0xFF7A5B00), Color(0xFFF0DC8A))
        "moderate" -> Triple(Color(0xFFFFE9D2), Color(0xFF9A4A00), Color(0xFFF3C08E))
        "high", "severe" -> Triple(Color(0xFFFDE0DE), Color(0xFF8A2F2B), Color(0xFFF0AAA6))
        else -> Triple(Color(0xFFEEF1EF), Color(0xFF4D6054), Color(0xFFD3DAD5))
    }
    Surface(shape = RoundedCornerShape(50), color = bg, border = BorderStroke(1.dp, border)) {
        Text(
            label,
            Modifier.padding(horizontal = if (compact) 6.dp else 10.dp, vertical = if (compact) 2.dp else 4.dp),
            color = fg, fontSize = if (compact) 10.sp else 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/** Server toxicity values folded to the keys the web styles by. Empty / "safe" / "non-toxic" = "none". */
fun normalizeToxicity(raw: String?): String = when (val k = raw?.trim()?.lowercase().orEmpty()) {
    "", "none", "non-toxic", "nontoxic", "safe", "not toxic" -> "none"
    "medium" -> "moderate"
    else -> k
}

/** "Added Oct 31, 2026" from an ISO timestamp, or null when there is no (valid) date. */
fun formatAdded(raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    return try {
        "Added " + DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
            .withZone(ZoneId.systemDefault())
            .format(Instant.parse(raw))
    } catch (e: Exception) {
        null
    }
}

// ---------------------------------------------------------------------------
// Helpers used by LibraryScreen, HomeScreen and PlantInventoryScreen
// ---------------------------------------------------------------------------

/**
 * What a card shows besides the name.
 * [toxicity] is normalised ("none", "mild", ...) and null while it is still unknown.
 * [benefits] is the primary description's benefits text, for the library note.
 */
data class CardInfo(
    val type: String,
    val description: String?,
    val toxicity: String? = null,
    val benefits: String? = null
)

/**
 * Type, description, toxicity and benefits for a card. Uses the list row's values when it has them;
 * otherwise reads the plant's profile (cached, shared with the other badges).
 */
@Composable
fun rememberCardInfo(
    plantId: String,
    vm: LibraryViewModel,
    listDescription: String?,
    listToxicity: String? = null
): CardInfo {
    val client = (LocalContext.current.applicationContext as PlantellectApp).container.network.okHttpClient
    val initialTox = listToxicity?.let { normalizeToxicity(it) }
    val info by produceState(CardInfo("", listDescription, initialTox), plantId, listDescription, listToxicity) {
        val p = (fetchPlantProfile(client, vm, plantId) as? ProfileLoad.Ready)?.data ?: return@produceState
        val primary = p.descriptions.firstOrNull { it.isPrimary } ?: p.descriptions.firstOrNull()
        val text = listDescription?.takeIf { it.isNotBlank() }
            ?: listOf(primary?.uses, primary?.benefits, primary?.looks)
                .firstOrNull { !it.isNullOrBlank() }
                ?.replace(Regex("\\s*\\n+\\s*"), " · ")
        val benefits = primary?.benefits?.takeIf { it.isNotBlank() }
            ?.replace(Regex("\\s*\\n+\\s*"), " ")
        value = CardInfo(
            type = p.typeLabel,
            description = text,
            toxicity = normalizeToxicity(listToxicity ?: p.toxicityLevel),
            benefits = benefits
        )
    }
    return info
}

/** Small rounded label with the plant type, e.g. "Flower" or "Herbal". Hidden while unknown. */
@Composable
fun TypePill(type: String) {
    if (type.isBlank()) return
    Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.secondaryContainer) {
        Text(
            type.replaceFirstChar { it.uppercase() },
            Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSecondaryContainer,
            maxLines = 1
        )
    }
}

/**
 * Pull-to-refresh that works on any Compose / Material3 version (only basic APIs).
 * Pull the list down while it is at the top, release past the threshold to refresh.
 */
@Composable
fun Refreshable(
    refreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    val density = LocalDensity.current
    val thresholdPx = with(density) { 72.dp.toPx() }
    val indicatorPx = with(density) { 40.dp.toPx() }
    var pull by remember { mutableFloatStateOf(0f) }
    val currentOnRefresh by rememberUpdatedState(onRefresh)

    val connection = remember(thresholdPx) {
        object : NestedScrollConnection {
            // Scrolling back up while pulled: shrink the pull first.
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (pull > 0f && available.y < 0f) {
                    val used = maxOf(available.y, -pull)
                    pull += used
                    return Offset(0f, used)
                }
                return Offset.Zero
            }

            // The list is at the top and the finger keeps pulling down: grow the pull.
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (available.y > 0f) {
                    pull = (pull + available.y * 0.5f).coerceAtMost(thresholdPx * 2f)
                    return Offset(0f, available.y)
                }
                return Offset.Zero
            }

            override suspend fun onPreFling(available: Velocity): Velocity {
                if (pull >= thresholdPx) currentOnRefresh()
                pull = 0f
                return Velocity.Zero
            }

            override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
                pull = 0f
                return Velocity.Zero
            }
        }
    }

    Box(modifier.nestedScroll(connection)) {
        content()

        if (refreshing || pull > 0f) {
            val y = (if (refreshing) thresholdPx else pull) * 0.7f - indicatorPx
            Surface(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .offset { IntOffset(0, y.roundToInt()) }
                    .size(40.dp),
                shape = CircleShape,
                color = MaterialTheme.colorScheme.surface,
                shadowElevation = 4.dp
            ) {
                Box(contentAlignment = Alignment.Center) {
                    if (refreshing) {
                        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.5.dp)
                    } else {
                        Icon(
                            Icons.Filled.Refresh, contentDescription = "Release to refresh",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(22.dp).graphicsLayer { rotationZ = (pull / thresholdPx) * 270f }
                        )
                    }
                }
            }
        }
    }
}

/**
 * Older toxicity badge, still used by screens I haven't touched (PlantInventoryScreen).
 * Home and Library now use [ToxicityChip], which has the web labels and colours.
 */
@Composable
fun CardToxicityBadge(plantId: String, toxicity: String?, vm: LibraryViewModel) {
    val c = MaterialTheme.colorScheme
    val client = (LocalContext.current.applicationContext as PlantellectApp).container.network.okHttpClient
    val level: String? by produceState<String?>(toxicity?.trim()?.lowercase(), plantId, toxicity) {
        if (toxicity != null) { value = toxicity.trim().lowercase(); return@produceState }
        value = (fetchPlantProfile(client, vm, plantId) as? ProfileLoad.Ready)
            ?.data?.toxicityLevel?.trim()?.lowercase().orEmpty()
    }

    val l = level ?: return    // still loading: show nothing rather than a wrong answer
    val (text, bg, fg) = when (l) {
        "", "none", "non-toxic", "nontoxic", "safe", "not toxic" ->
            Triple("Non-toxic", c.primaryContainer, c.onPrimaryContainer)
        "mild", "low" -> Triple("Toxic · Mild", ScanWarn, LightOnSurface)
        "moderate", "medium" -> Triple("Toxic · Moderate", c.errorContainer, c.onErrorContainer)
        "severe", "high" -> Triple("Toxic · Severe", c.error, c.onError)
        else -> Triple("Toxic · ${l.replaceFirstChar { it.uppercase() }}", c.errorContainer, c.onErrorContainer)
    }
    Surface(shape = RoundedCornerShape(50), color = bg) {
        Text(text, Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
            style = MaterialTheme.typography.labelMedium, color = fg, maxLines = 1)
    }
}