package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.plantellect.mobileplantellect.data.logic.RichText
import com.plantellect.mobileplantellect.data.remote.dto.ProfileLoad
import com.plantellect.mobileplantellect.ui.theme.extraColors
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import com.plantellect.mobileplantellect.viewmodel.SearchBy
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.roundToInt

/**
 * Plant library: search (from the first letter), common / scientific filter, type filter,
 * two-column grid, 10 cards per page with Previous / Next, pull to refresh.
 * The name / type filters sit behind a "Filters" drop down that shows or hides them.
 * [onOpenBotanist] opens a contributor's profile when their name is tapped inside the plant profile.
 */
@Composable
fun LibraryScreen(
    vm: LibraryViewModel,
    onOpenBotanist: (String) -> Unit = {},
    resume: Pair<String, String>? = null,
    onResumeChange: (Pair<String, String>?) -> Unit = {}
) {
    val ui by vm.ui.collectAsState()
    val gridState = rememberLazyGridState()
    var open by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }
    // [resume] (kept by the app shell) is the plant to bring back after a profile; the shell clears it when you
    // leave that profile through the sidebar, so coming back to the library later shows just the library.
    LaunchedEffect(Unit) { resume?.let { open = it; onResumeChange(null) } }

    // false = filters hidden, true = filters shown. Change to true to start expanded.
    var filtersOpen by remember { mutableStateOf(false) }
    val arrowRotation by animateFloatAsState(if (filtersOpen) 180f else 0f, label = "filtersArrow")

    // Jump back to the first card whenever the page (or the results) change.
    LaunchedEffect(ui.page, ui.total) { gridState.scrollToItem(0) }
    // Read the plant types again when this screen opens and whenever the Filters panel is toggled,
    // so a type added on the website shows up without restarting the app.
    LaunchedEffect(filtersOpen) { vm.refreshTypes() }

    Column(Modifier.fillMaxSize()) {
        // Search box: always visible
        OutlinedTextField(
            value = ui.query, onValueChange = vm::setQuery,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            singleLine = true, shape = MaterialTheme.shapes.small,
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
                HScroll(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)) {
                    SearchBy.entries.forEach {
                        FilterChip(ui.searchBy == it, { vm.setSearchBy(it) }, label = { Text(it.label) })
                    }
                }

                // Plant type filter
                if (ui.types.isNotEmpty()) {
                    HScroll(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp)) {
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
                        // addedAt = p.dateUploaded,   // optional: if your DTO has the field. Otherwise the
                        //                             // date is read from the plant profile automatically.
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
                PlantOutlinedButton(onClick = vm::prevPage, enabled = ui.hasPrev && !ui.loading) { Text("Previous") }
                Text(
                    "Page ${ui.page} of ${ui.pageCount}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                PlantOutlinedButton(onClick = vm::nextPage, enabled = ui.hasNext && !ui.loading) { Text("Next") }
            }
        }
    }

    open?.let { (id, name) ->
        PlantProfileDialog(
            plantId = id,
            fallbackName = name,
            heroUrl = null,
            vm = vm,
            // Remember the plant so Back on the profile returns to it.
            onOpenBotanist = { person -> onResumeChange(open); open = null; onOpenBotanist(person) },
            onClose = { open = null }
        )
    }
}

// ---------------------------------------------------------------------------
// The Library card: fixed-size grid version of the web card (.plant-grid .plant-card)
// ---------------------------------------------------------------------------

/** Every Library card is exactly as tall as every other one: 252 dp at normal font size, taller with larger text. */

/**
 * Same order as the web card (image, name, chips, date, note), but every part has a fixed slot,
 * so all cards have the same size: 90 dp image, one-line name, a two-line chip slot,
 * a date slot, and a 2-line note. Anything longer is clipped or cut with "…".
 *
 * The "Added ..." date comes from [addedAt] when the caller has it, otherwise from the
 * plant's profile (dateUploaded), read through [rememberCardInfo].
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
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
    val added = formatAdded(addedAt ?: info.addedIso)
    // Long-press: the photo, big and zoomable. A tap still opens the plant.
    val zoomPhoto = rememberCardPhotoZoom(id, photoUrl, name, vm)

    // Every slot below grows with the phone's font size (up to 2x), so all cards stay equal and nothing is cut.
    CappedFontScale(2f) {
      BoxWithConstraints(modifier.fillMaxWidth()) {
        val f = LocalDensity.current.fontScale
        // The photo follows the card's width (90 dp on a normal phone), so wide phones and tablets get a taller photo.
        val imageH = (maxWidth * 0.85f).coerceIn(100.dp, 220.dp)
        // Text on the card shrinks a little when the card is narrow (small phones, split screen).
        val ts = (maxWidth.value / 160f).coerceIn(0.85f, 1.2f)
        Card(
            Modifier.fillMaxWidth().height(imageH + 12.dp + (92 * f).dp).combinedClickable(onClick = onClick, onLongClick = zoomPhoto),
            shape = MaterialTheme.shapes.medium,
            colors = CardDefaults.cardColors(containerColor = c.surface),
            border = BorderStroke(1.dp, MaterialTheme.extraColors.forest.copy(alpha = 0.12f)),
            elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
        ) {
            Column(Modifier.fillMaxSize()) {
                // image box: fixed 90 dp, soft green gradient behind the photo
                Box(
                    Modifier.fillMaxWidth().height(imageH)
                        .background(Brush.linearGradient(listOf(MaterialTheme.extraColors.photoBackdropStart, MaterialTheme.extraColors.photoBackdropEnd)))
                ) {
                    PlantCardPhoto(id, photoUrl, name, vm, Modifier.fillMaxSize())
                }

                // name: always a two-line slot, so a long name wraps instead of being cut after one line
                FitText(
                    name.uppercase(),
                    fontSize = (11 * ts).sp, minFontSize = 8.sp, lineHeightRatio = 1.2f,
                    modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 5.dp, bottom = 2.dp),
                    color = c.onSurface,
                    fontWeight = FontWeight.Bold, letterSpacing = 0.017.em,
                    minLines = 2, maxLines = 2
                )

                // chips: a fixed two-line slot (clipped), so wrapping never changes the card height
                FlowRow(
                    Modifier.fillMaxWidth().height((20 * f).dp).clipToBounds()
                        .padding(start = 8.dp, end = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp)
                ) {
                    if (info.type.isNotBlank()) PlantTypeChip(info.type, compact = true)
                    info.toxicity?.let { ToxicityChip(it, compact = true) }
                }

                // date: always reserves its slot
                Row(
                    Modifier.fillMaxWidth().height((13 * f).dp).padding(start = 8.dp, end = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (added != null) {
                        Icon(Icons.Filled.CalendarToday, null, Modifier.size(9.dp), tint = c.onSurfaceVariant)
                        Spacer(Modifier.width(3.dp))
                        FitText(added, fontSize = (9 * ts).sp, minFontSize = 7.sp, color = c.onSurfaceVariant, modifier = Modifier.weight(1f, fill = false))
                    }
                }

                // note: label + 2-line text, fills whatever is left
                val harmful = info.toxicity != null && info.toxicity != "none"
                val label = if (harmful) "⚠ Watch out" else "Benefits"
                val text = if (harmful) "Handle with care." else info.benefits   // replaced by the recorded warning once the DTO field is wired

                Column(
                    Modifier.fillMaxWidth().weight(1f).clipToBounds()
                        .padding(start = 8.dp, end = 8.dp, top = 1.dp)
                ) {
                    FitText(
                        label.uppercase(),
                        fontSize = (8 * ts).sp, minFontSize = 6.sp,
                        color = if (harmful) c.error else MaterialTheme.extraColors.forest,
                        fontWeight = FontWeight.Bold, letterSpacing = 0.06.em
                    )
                    FitText(
                        if (text.isNullOrBlank()) "No details added yet." else text,
                        fontSize = (10 * ts).sp, minFontSize = 7.sp, lineHeightRatio = 1.2f,
                        modifier = Modifier.padding(top = 0.dp).fillMaxWidth(),
                        color = when {
                            text.isNullOrBlank() -> c.outline
                            harmful -> c.error
                            else -> c.onSurfaceVariant
                        },
                        fontStyle = if (text.isNullOrBlank()) FontStyle.Italic else FontStyle.Normal,
                        maxLines = 2
                    )
                }
            }
        }
      }
    }
}

/** Plant type chip: green tint, thin green border (.plant-chip-type). [compact] = smaller text and padding. */
@Composable
fun PlantTypeChip(type: String, compact: Boolean = false) {
    Surface(
        shape = RoundedCornerShape(50),
        color = MaterialTheme.extraColors.forest.copy(alpha = 0.10f),
        border = BorderStroke(1.dp, MaterialTheme.extraColors.forest.copy(alpha = 0.25f))
    ) {
        FitText(
            type.replaceFirstChar { it.uppercase() },
            fontSize = if (compact) 9.sp else 12.sp, minFontSize = 6.sp,
            modifier = Modifier.padding(horizontal = if (compact) 5.dp else 10.dp, vertical = if (compact) 1.dp else 4.dp),
            color = MaterialTheme.extraColors.onForestChip, fontWeight = FontWeight.SemiBold
        )
    }
}

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
    val extra = MaterialTheme.extraColors
    val (bg, fg, border) = when (k) {
        "none" -> extra.toxNone.triple
        "low", "mild" -> extra.toxMild.triple
        "moderate" -> extra.toxModerate.triple
        "high", "severe" -> extra.toxSevere.triple
        else -> extra.toxUnknown.triple
    }
    Surface(shape = RoundedCornerShape(50), color = bg, border = BorderStroke(1.dp, border)) {
        FitText(
            label,
            fontSize = if (compact) 9.sp else 12.sp, minFontSize = 6.sp,
            modifier = Modifier.padding(horizontal = if (compact) 5.dp else 10.dp, vertical = if (compact) 1.dp else 4.dp),
            color = fg, fontWeight = FontWeight.SemiBold
        )
    }
}

/** Server toxicity values folded to the keys the web styles by. Empty / "safe" / "non-toxic" = "none". */
fun normalizeToxicity(raw: String?): String = when (val k = raw?.trim()?.lowercase().orEmpty()) {
    "", "none", "non-toxic", "nontoxic", "safe", "not toxic" -> "none"
    "medium" -> "moderate"
    else -> k
}

/**
 * "Added Oct 31, 2026" from the server's timestamp (ISO instant like 2026-10-31T08:12:00.000Z,
 * or a plain yyyy-MM-dd date), or null when there is no (valid) date.
 */
fun formatAdded(raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    val fmt = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
    return try {
        "Added " + fmt.withZone(ZoneId.systemDefault()).format(Instant.parse(raw))
    } catch (e: Exception) {
        try {
            "Added " + fmt.format(LocalDate.parse(raw.trim().take(10)))
        } catch (e2: Exception) {
            null
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers used by LibraryScreen, HomeScreen and PlantInventoryScreen
// ---------------------------------------------------------------------------

/**
 * What a card shows besides the name.
 * [toxicity] is normalised ("none", "mild", ...) and null while it is still unknown.
 * [benefits] is the primary description's benefits text, for the library note.
 * [addedIso] is the plant's upload date as the server sent it (dateUploaded), null while unknown.
 */
data class CardInfo(
    val type: String,
    val description: String?,
    val toxicity: String? = null,
    val benefits: String? = null,
    val addedIso: String? = null
)

/**
 * Type, description, toxicity, benefits and upload date for a card. Uses the list row's values
 * when it has them; otherwise reads the plant's profile (cached, shared with the other badges).
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
        // Cards show one short line: the typed marks (**, ==, *- ...) are removed, like RichText.plain on the website.
        val text = listDescription?.takeIf { it.isNotBlank() }?.let { RichText.plain(it) }
            ?: listOf(primary?.uses, primary?.benefits, primary?.looks)
                .firstOrNull { !it.isNullOrBlank() }
                ?.let { RichText.plain(it) }
        val benefits = primary?.benefits?.takeIf { it.isNotBlank() }
            ?.let { RichText.plain(it) }
        value = CardInfo(
            type = p.typeLabel,
            description = text,
            toxicity = normalizeToxicity(listToxicity ?: p.toxicityLevel),
            benefits = benefits,
            addedIso = p.addedIso
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
    /** false = the pull does nothing (a page that has its own refresh inside). */
    enabled: Boolean = true,
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

    Box(if (enabled) modifier.nestedScroll(connection) else modifier) {
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
        "mild", "low" -> Triple("Toxic · Mild", MaterialTheme.extraColors.warning, MaterialTheme.extraColors.onWarning)
        "moderate", "medium" -> Triple("Toxic · Moderate", c.errorContainer, c.onErrorContainer)
        "severe", "high" -> Triple("Toxic · Severe", c.error, c.onError)
        else -> Triple("Toxic · ${l.replaceFirstChar { it.uppercase() }}", c.errorContainer, c.onErrorContainer)
    }
    Surface(shape = RoundedCornerShape(50), color = bg) {
        Text(text, Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
            style = MaterialTheme.typography.labelMedium, color = fg, maxLines = 1)
    }
}