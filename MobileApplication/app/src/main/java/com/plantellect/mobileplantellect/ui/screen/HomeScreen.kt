package com.plantellect.mobileplantellect.ui.screen

import com.plantellect.mobileplantellect.ui.theme.ExtraColors
import com.plantellect.mobileplantellect.ui.theme.extraColors
import androidx.activity.ComponentActivity
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Eco
import androidx.compose.material.icons.filled.LocalFlorist
import androidx.compose.material.icons.filled.Park
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import kotlinx.coroutines.delay

/**
 * Home: quick actions, an auto-scrolling row of plant cards, and a short list below it.
 * Tapping a card opens that plant's profile directly. Pull down to refresh.
 * [onOpenBotanist] opens a contributor's profile when their name is tapped inside the plant profile.
 */
@Composable
fun HomeScreen(
    onNavigateToScan: () -> Unit,
    onNavigateToInventory: () -> Unit,
    vm: LibraryViewModel = libraryViewModel(),
    onOpenBotanist: (String) -> Unit = {},
    resume: Pair<String, String>? = null,
    onResumeChange: (Pair<String, String>?) -> Unit = {}
) {
    val ui by vm.ui.collectAsState()
    var open by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }   // plant id to name
    // [resume] (kept by the app shell) is the plant to bring back after a profile.
    LaunchedEffect(Unit) { resume?.let { open = it; onResumeChange(null) } }
    val featured = remember(ui.items) { ui.items.take(10) }
    val more = remember(ui.items) { ui.items.drop(10).take(6) }

    Refreshable(refreshing = ui.loading, onRefresh = { vm.reload() }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Plantellect", style = MaterialTheme.typography.headlineSmall)
                    Text(
                        "Identify, learn and record plants.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            item {
                Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    ActionTile(Icons.Filled.CameraAlt, "Capture Plant", Modifier.weight(1f), onNavigateToScan)
                    ActionTile(Icons.Filled.LocalFlorist, "Plant Library", Modifier.weight(1f), onNavigateToInventory)
                }
            }

            item {
                Text(
                    "Featured plants", Modifier.padding(horizontal = 16.dp),
                    style = MaterialTheme.typography.titleLarge
                )
            }

            item {
                when {
                    featured.isNotEmpty() -> AutoScrollRow(items = featured, key = { it.cardId }) { p ->
                        PlantCard(
                            plantId = p.cardId, name = p.cardName, scientificName = p.cardScientific,
                            description = p.cardDescription, photoUrl = vm.imageUrl(p),
                            toxicityLevel = p.cardToxicity, vm = vm,
                            modifier = Modifier.fillMaxWidth(),
                            index = featured.indexOf(p),
                            // addedAt = p.dateUploaded,   // optional: if your DTO has the field. Otherwise the
                            //                             // date is read from the plant profile automatically.
                            onClick = { open = p.cardId to p.cardName }
                        )
                    }
                    ui.loading -> Box(Modifier.fillMaxWidth().padding(24.dp), Alignment.Center) { CircularProgressIndicator() }
                    else -> Text(
                        ui.error ?: "No plants yet. Pull down to refresh.",
                        Modifier.padding(horizontal = 16.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            if (more.isNotEmpty()) {
                item {
                    Text(
                        "More plants", Modifier.padding(horizontal = 16.dp),
                        style = MaterialTheme.typography.titleLarge
                    )
                }
                items(more, key = { it.cardId }) { p ->
                    PlantCard(
                        plantId = p.cardId, name = p.cardName, scientificName = p.cardScientific,
                        description = p.cardDescription, photoUrl = vm.imageUrl(p),
                        toxicityLevel = p.cardToxicity, vm = vm,
                        modifier = Modifier.padding(horizontal = 16.dp).fillMaxWidth(),
                        // addedAt = p.dateUploaded,
                        onClick = { open = p.cardId to p.cardName }
                    )
                }
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

@Composable
private fun ActionTile(icon: ImageVector, label: String, modifier: Modifier, onClick: () -> Unit) {
    Card(
        modifier.clickable(onClick = onClick),
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    ) {
        Column(
            Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Icon(icon, null, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer)
            Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers used by HomeScreen (and LibraryScreen / PlantInventoryScreen)
// ---------------------------------------------------------------------------

/**
 * ONE LibraryViewModel shared by Home and Library: it lives in the activity, so the list,
 * search and filters are loaded once. Uses the factory already in AppContainer.
 */
@Composable
fun libraryViewModel(): LibraryViewModel {
    val context = LocalContext.current
    val app = context.applicationContext as PlantellectApp
    return viewModel(
        viewModelStoreOwner = context as ComponentActivity,
        factory = app.container.viewModelFactory
    )
}

/**
 * Keeps drifting to the right by itself, forever, and never turns around. It starts in the middle of an endless row,
 * so you can also swipe it back to the left as far as you like. Pauses while the user touches it, then carries on
 * to the right.
 * Card width = web --pc-w (230).
 */
@Composable
fun <T> AutoScrollRow(
    items: List<T>,
    key: (T) -> Any,
    cardWidth: Dp = 230.dp,
    content: @Composable (T) -> Unit
) {
    if (items.isEmpty()) return
    // Start far from index 0 (on the first card of a lap), otherwise there is nothing to the left to scroll to.
    val start = remember { (Int.MAX_VALUE / 4).let { it - it % items.size } }
    val state = rememberLazyListState(initialFirstVisibleItemIndex = start)
    val dragged by state.interactionSource.collectIsDraggedAsState()
    var resumeTick by remember { mutableIntStateOf(0) }

    LaunchedEffect(dragged) { if (!dragged) { delay(2000); resumeTick++ } }
    LaunchedEffect(items.size, dragged, resumeTick) {
        if (dragged) return@LaunchedEffect
        while (true) {
            delay(16)
            state.scrollBy(1.4f)
        }
    }

    LazyRow(
        state = state,
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp)   // web .slider-track gap
    ) {
        items(count = Int.MAX_VALUE, key = { i -> "${key(items[i % items.size])}#$i" }) { i ->
            Box(Modifier.width(cardWidth)) { content(items[i % items.size]) }
        }
    }
}

// ---------------------------------------------------------------------------
// The Home card: a copy of the web slider card (.slider-track .plant-card)
// ---------------------------------------------------------------------------

/** Cards whose entrance animation already played, so a card scrolled back into view doesn't replay it. */
private val entrancePlayed = HashSet<String>()

/** "Non-Herbal & Flower" becomes "non-herbal-flower", the key the web styles by. */
private fun typeSlug(type: String): String =
    type.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')

/** --ph-a / --ph-b per plant type (home.css). */
private fun placeholderColors(slug: String, x: ExtraColors): Pair<Color, Color> = when (slug) {
    "flower" -> x.flowerTint.a to x.flowerTint.b
    "non-herbal-flower" -> x.nonHerbalFlowerTint.a to x.nonHerbalFlowerTint.b
    else -> x.defaultTint.a to x.defaultTint.b
}

private fun typeArt(slug: String): ImageVector = when (slug) {
    "flower" -> Icons.Filled.LocalFlorist
    "non-herbal-flower" -> Icons.Filled.Park
    else -> Icons.Filled.Eco
}

// leaf bits: x, size (dp), period (s), phase (0..1), sideways drift (dp)
private data class Bit(val x: Float, val size: Int, val period: Int, val phase: Float, val dx: Int)
private val bits = listOf(
    Bit(0.14f, 9, 12, 0.08f, 26),
    Bit(0.32f, 6, 10, 0.50f, -18),
    Bit(0.58f, 10, 8, 0.37f, 20),
    Bit(0.76f, 7, 6, 0.66f, -24),
    Bit(0.90f, 5, 10, 0.60f, -10)
)

/** The artwork shown behind (and until) the photo: gradient, glow, swaying plant, drifting leaves. */
@Composable
private fun PlaceholderArt(slug: String, phA: Color, phB: Color) {
    val extra = MaterialTheme.extraColors
    val inf = rememberInfiniteTransition(label = "ph")
    val sway = inf.animateFloat(
        -3f, 3f, infiniteRepeatable(tween(4500, easing = EaseInOut), RepeatMode.Reverse), label = "sway"
    )
    val breath = inf.animateFloat(
        0.7f, 1f, infiniteRepeatable(tween(4000, easing = EaseInOut), RepeatMode.Reverse), label = "breath"
    )
    val clock = inf.animateFloat(
        0f, 1f, infiniteRepeatable(tween(120_000, easing = LinearEasing)), label = "clock"
    )

    BoxWithConstraints(
        Modifier.fillMaxSize().drawBehind {
            drawRect(
                Brush.radialGradient(
                    listOf(phA, phB),
                    center = Offset(size.width * 0.25f, size.height * 0.15f),
                    radius = size.maxDimension * 1.1f
                )
            )
        }
    ) {
        val w = maxWidth
        val h = maxHeight

        // soft glow behind the plant
        Box(
            Modifier.align(Alignment.TopCenter).offset(y = h * 0.36f - w * 0.36f)
                .size(w * 0.72f)
                .graphicsLayer {
                    alpha = breath.value
                    val s = 0.92f + 0.16f * (breath.value - 0.7f) / 0.3f
                    scaleX = s
                    scaleY = s
                }
                .drawBehind {
                    drawCircle(Brush.radialGradient(listOf(extra.onOverlay.copy(alpha = 0.42f), Color.Transparent)))
                }
        )

        // the plant
        Icon(
            typeArt(slug), contentDescription = null,
            tint = extra.onOverlay.copy(alpha = 0.92f),
            modifier = Modifier.align(Alignment.TopCenter).offset(y = h * 0.08f)
                .size(h * 0.50f)
                .graphicsLayer { rotationZ = sway.value; transformOrigin = TransformOrigin(0.5f, 0.94f) }
        )

        // leaves drifting upward
        bits.forEach { b ->
            Box(
                Modifier.align(Alignment.BottomStart)
                    .offset(x = w * b.x, y = h * 0.12f)
                    .size(b.size.dp)
                    .graphicsLayer {
                        val p = (clock.value * (120f / b.period) + b.phase) % 1f
                        translationY = -p * h.toPx() * 1.35f
                        translationX = p * b.dx.dp.toPx()
                        rotationZ = p * 300f
                        alpha = when {
                            p < 0.1f -> p / 0.1f * 0.8f
                            p < 0.9f -> 0.8f - (p - 0.1f) / 0.8f * 0.2f
                            else -> 0.6f * (1f - p) / 0.1f
                        }
                    }
                    .background(
                        extra.onOverlay.copy(alpha = 0.55f),
                        RoundedCornerShape(topStartPercent = 0, topEndPercent = 100, bottomEndPercent = 0, bottomStartPercent = 100)
                    )
            )
        }
    }
}

/**
 * Same card as the web "Newest plants" slider: full photo, type + toxicity chips top-left,
 * and a gradient at the bottom with the uppercase name, the green bar, the scientific name,
 * the added date and a 2-line description. Entrance animation, slow photo zoom and the
 * animated placeholder follow home.css.
 *
 * The "Added ..." date comes from [addedAt] when the caller has it, otherwise from the
 * plant's profile (dateUploaded), read through [rememberCardInfo].
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun PlantCard(
    plantId: String,
    name: String,
    scientificName: String?,
    description: String?,
    photoUrl: String?,
    toxicityLevel: String?,
    vm: LibraryViewModel,
    modifier: Modifier = Modifier,
    index: Int = 0,
    addedAt: String? = null,
    onClick: () -> Unit
) {
    val info = rememberCardInfo(plantId, vm, description, toxicityLevel)
    val slug = typeSlug(info.type)
    val extra = MaterialTheme.extraColors
    val (phA, phB) = placeholderColors(slug, extra)
    val added = formatAdded(addedAt ?: info.addedIso)
    // Long-press: the photo, big and zoomable. A tap still opens the plant.
    val zoomPhoto = rememberCardPhotoZoom(plantId, photoUrl, name, vm)

    // pcIn: fade + rise 24 + scale .96 -> 1, 70 ms stagger, played once per card
    val enter = remember(plantId) { Animatable(if (plantId in entrancePlayed) 1f else 0f) }
    LaunchedEffect(plantId) {
        if (enter.value < 1f) {
            delay(index * 70L)
            enter.animateTo(1f, tween(600, easing = CubicBezierEasing(0.2f, 0.7f, 0.2f, 1f)))
        }
        entrancePlayed.add(plantId)
    }

    // pcKen: the photo slowly zooms 1 -> 1.09 and drifts
    val ken = rememberInfiniteTransition(label = "ken").animateFloat(
        0f, 1f, infiniteRepeatable(tween(16_000, easing = EaseInOut), RepeatMode.Reverse), label = "kenT"
    )

    // The card grows with the phone's font size (up to 2x) instead of clipping its text: 310 dp at normal size.
    CappedFontScale(2f) {
      BoxWithConstraints(modifier) {
        val fontScale = androidx.compose.ui.platform.LocalDensity.current.fontScale
        // Text and spacing follow the card's width (1.0 at ~340 dp) so narrow phones and tablets both look right.
        val ts = (maxWidth.value / 340f).coerceIn(0.85f, 1.2f)
        val pad = (12 * ts).dp
        Card(
            Modifier.fillMaxWidth()
                .height((190 + 105 * fontScale).dp)
                .graphicsLayer {
                    val t = enter.value
                    alpha = t
                    translationY = (1f - t) * 24.dp.toPx()
                    val s = 0.96f + 0.04f * t
                    scaleX = s
                    scaleY = s
                }
                .combinedClickable(onClick = onClick, onLongClick = zoomPhoto),
            shape = MaterialTheme.shapes.medium,
            colors = CardDefaults.cardColors(containerColor = phB),
            elevation = CardDefaults.cardElevation(defaultElevation = 6.dp)
        ) {
            Box(Modifier.fillMaxSize()) {
                // photo layer: artwork underneath, photo on top
                Box(
                    Modifier.fillMaxSize().graphicsLayer {
                        val k = ken.value
                        val s = 1f + 0.09f * k
                        scaleX = s
                        scaleY = s
                        translationX = -0.015f * k * size.width
                        translationY = -0.01f * k * size.height
                    }
                ) {
                    PlaceholderArt(slug, phA, phB)
                    PlantCardPhoto(plantId, photoUrl, name, vm, Modifier.fillMaxSize())
                }

                // type + toxicity, top-left
                FlowRow(
                    Modifier.align(Alignment.TopStart).fillMaxWidth().padding((8 * ts).dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    if (info.type.isNotBlank()) {
                        Surface(shape = RoundedCornerShape(50), color = extra.onOverlay.copy(alpha = 0.88f)) {
                            FitText(
                                info.type.replaceFirstChar { it.uppercase() },
                                fontSize = 10.sp, minFontSize = 7.sp,
                                modifier = Modifier.padding(horizontal = 9.dp, vertical = 3.dp),
                                color = phB, fontWeight = FontWeight.Bold,
                                letterSpacing = 0.04.em
                            )
                        }
                    }
                    info.toxicity?.let { ToxicityChip(it) }
                }

                // name + details on the dark gradient
                Column(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                        .background(
                            Brush.verticalGradient(
                                0f to extra.photoShade.copy(alpha = 0f),
                                0.55f to extra.photoShade.copy(alpha = 0.78f),
                                1f to extra.photoShade.copy(alpha = 0.94f)
                            )
                        )
                        .padding(start = pad, end = pad, top = 36.dp, bottom = pad)
                ) {
                    FitText(
                        name.uppercase(),
                        fontSize = (14 * ts).sp, minFontSize = 10.sp, lineHeightRatio = 1.2f,
                        color = extra.onOverlay,
                        fontWeight = FontWeight.Bold, letterSpacing = 0.06.em,
                        maxLines = 2,
                        style = TextStyle(shadow = Shadow(extra.overlay.copy(alpha = 0.4f), Offset(0f, 2f), 3f))
                    )
                    Box(
                        Modifier.padding(top = 4.dp, bottom = 3.dp)
                            .size(width = 24.dp, height = 2.dp)
                            .background(extra.photoAccent, RoundedCornerShape(3.dp))
                    )
                    if (!scientificName.isNullOrBlank()) {
                        FitText(
                            scientificName, fontSize = (11 * ts).sp, minFontSize = 8.sp,
                            color = extra.onOverlay.copy(alpha = 0.78f), fontStyle = FontStyle.Italic,
                            maxLines = 1
                        )
                    }
                    if (added != null) {
                        Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Filled.CalendarToday, null, Modifier.size(11.dp),
                                tint = extra.onOverlay.copy(alpha = 0.72f)
                            )
                            Spacer(Modifier.width(4.dp))
                            FitText(added, fontSize = (10 * ts).sp, minFontSize = 7.sp, color = extra.onOverlay.copy(alpha = 0.72f))
                        }
                    }
                    if (!info.description.isNullOrBlank()) {
                        FitText(
                            info.description,
                            fontSize = (11 * ts).sp, minFontSize = 8.sp, lineHeightRatio = 1.3f,
                            modifier = Modifier.padding(top = 4.dp),
                            color = extra.onOverlay.copy(alpha = 0.9f),
                            maxLines = 1
                        )
                    }
                }
            }
        }
      }
    }
}