package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.ui.draw.alpha
import kotlinx.coroutines.delay
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.LocalFlorist
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import kotlin.math.abs
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.data.remote.dto.PlantProfileData
import com.plantellect.mobileplantellect.data.remote.dto.ProfileDescription
import com.plantellect.mobileplantellect.data.remote.dto.ProfileLoad
import com.plantellect.mobileplantellect.data.remote.dto.ProfilePerson
import com.plantellect.mobileplantellect.ui.theme.ContributorPalette
import com.plantellect.mobileplantellect.ui.theme.contributor
import com.plantellect.mobileplantellect.ui.theme.extraColors
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import kotlinx.coroutines.launch

/**
 * The plant's profile, loaded from GET /api/plants/:plantId: photos, names, category and
 * toxicity, what it looks like, uses, benefits, things to watch out for, other botanists'
 * descriptions (each with thumbs up / down), and who recorded / reviewed / reported it.
 * Every contributor shows their profile picture and a tappable, underlined name that opens
 * their profile ([onOpenBotanist]). Full screen over the library.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PlantProfileDialog(
    plantId: String,
    fallbackName: String,
    heroUrl: String?,
    vm: LibraryViewModel,
    onOpenBotanist: (String) -> Unit,
    onClose: () -> Unit
) {
    val c = MaterialTheme.colorScheme
    val client = (LocalContext.current.applicationContext as PlantellectApp).container.network.okHttpClient
    var attempt by remember { mutableStateOf(0) }
    val state by produceState<ProfileLoad>(ProfileLoad.Loading, plantId, attempt) {
        value = ProfileLoad.Loading
        value = fetchPlantProfile(client, vm, plantId, force = attempt > 0)
    }
    val votes = rememberVotes(client, vm, plantId, reloadKey = attempt)
    var viewing by remember { mutableStateOf<String?>(null) }

    // The same sidebar as the rest of the app (this screen is its own window, so it gets its own copy).
    val nav = LocalAppNav.current
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val drawerScope = rememberCoroutineScope()

    // Finger zoom: pinch to magnify, drag to move around while zoomed. Nothing is resized or re-laid out: the page is
    // only magnified like a photo, so text and boxes keep their size and position.
    val zoom = remember { FingerZoom() }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = c.background) {
            Box(Modifier.fillMaxSize().plantBackdrop()) {
                val body: @Composable () -> Unit = {
                    Column(Modifier.fillMaxSize()) {
                        // One row: Menu and Back on the left, Contribute at the right end. It is outside the scrolling
                        // page, so it stays in view however far you scroll.
                        Row(
                            Modifier.fillMaxWidth().statusBarsPadding().padding(start = 4.dp, end = 10.dp, top = 2.dp, bottom = 2.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            if (nav != null) IconButton({ drawerScope.launch { drawerState.open() } }, Modifier.size(40.dp)) {
                                Icon(Icons.Filled.Menu, contentDescription = "Menu")
                            }
                            AppBackButton(onClose, Modifier.padding(start = 2.dp))
                            // The plant's name takes the free space between Back and the right-hand buttons
                            // (it replaces the extra "Plant Library > name" row, so the bar is one short line).
                            Row(
                                Modifier.weight(1f).padding(horizontal = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                Icon(Icons.Filled.LocalFlorist, contentDescription = null, tint = c.primary, modifier = Modifier.size(18.dp))
                                Text(
                                    (state as? ProfileLoad.Ready)?.data?.name ?: fallbackName,
                                    style = MaterialTheme.typography.labelLarge, color = c.onSurfaceVariant,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis
                                )
                            }
                            if (zoom.scale > 1.01f) PlantTextButton({ zoom.reset() }) { Text("Reset zoom") }
                            // Only people who may record plants see it; it opens Record Plant on this plant.
                            val ready = state as? ProfileLoad.Ready
                            if (ready != null && nav != null && "record_plant" in nav.permissions) {
                                PlantButton(
                                    { onClose(); nav.contribute(plantId, ready.data.name) },
                                    modifier = Modifier.heightIn(max = 40.dp),
                                    contentPadding = PaddingValues(start = 12.dp, end = 16.dp)
                                ) {
                                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text("Contribute", maxLines = 1)
                                }
                            }
                        }

                        Box(Modifier.weight(1f).fillMaxWidth().clipToBounds().fingerZoom(zoom)) {
                            Column(
                                Modifier.fillMaxSize()
                                    .graphicsLayer {
                                        transformOrigin = TransformOrigin(0f, 0f)
                                        scaleX = zoom.scale; scaleY = zoom.scale
                                        translationX = zoom.tx; translationY = zoom.ty
                                    }
                                    .verticalScroll(rememberScrollState()).navigationBarsPadding()
                            ) {
                                when (val s = state) {
                                    ProfileLoad.Loading -> {
                                        PlantPhoto(heroUrl, fallbackName, Modifier.heroModifier(), maxPx = 1024)
                                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                            Text(fallbackName, style = MaterialTheme.typography.headlineSmall)
                                            LinearProgressIndicator(Modifier.fillMaxWidth())
                                        }
                                    }
                                    ProfileLoad.NotFound -> Message(
                                        "Plant not found",
                                        "This plant is not published yet, or it has no approved description."
                                    )
                                    ProfileLoad.Failed -> Message("Could not load plant", "Check your connection and try again.") {
                                        PlantButton({ attempt++ }) { Text("Try again") }
                                    }
                                    is ProfileLoad.Ready -> ProfileBody(
                                        p = s.data, fallbackHero = heroUrl, votes = votes,
                                        // A description just got hidden by down votes: draw the page again.
                                        onHidden = { attempt++ },
                                        onView = { viewing = it },
                                        // The "..." menu of every description: Request change opens the change form for THAT
                                        // description. Only people who may record plants get it.
                                        onRequestChange = nav?.takeIf { "record_plant" in it.permissions }?.let { n ->
                                            { descriptionId: String -> onClose(); n.requestChange(plantId, s.data.name, descriptionId) }
                                        },
                                        // The screen that shows this dialog hides it and brings it back when Back is pressed on the profile.
                                        onOpenBotanist = { id -> onOpenBotanist(id) }
                                    )
                                }
                            }
                        }
                    }
                }
                if (nav != null) {
                    ModalNavigationDrawer(
                        drawerState = drawerState,
                        drawerContent = {
                            PlantellectDrawerSheet(
                                permissions = nav.permissions,
                                currentRoute = "inventory",   // the plant profile belongs to the Plant Library
                                // Pick a page: close the sidebar and this profile, then go there.
                                onGo = { route -> drawerScope.launch { drawerState.close() }; onClose(); nav.go(route) },
                                onSignOut = { drawerScope.launch { drawerState.close() }; onClose(); nav.signOut() }
                            )
                        }
                    ) { body() }
                } else body()
            }
        }
    }

    viewing?.let { url -> PhotoZoomDialog(url, fallbackName) { viewing = null } }
}

private const val MAX_FINGER_ZOOM = 4f

/** How much the plant page is magnified and where it is moved to. 1 = normal; nothing else changes size. */
private class FingerZoom {
    var scale by mutableStateOf(1f)
    var tx by mutableStateOf(0f)
    var ty by mutableStateOf(0f)

    fun reset() { scale = 1f; tx = 0f; ty = 0f }

    /** Keeps the magnified page covering the whole viewport (no empty edges). */
    fun clamp(width: Float, height: Float) {
        tx = tx.coerceIn(width * (1f - scale), 0f)
        ty = ty.coerceIn(height * (1f - scale), 0f)
    }
}

/**
 * Two fingers pinch to magnify (up to 4x) and move together to shift the view. With one finger, while magnified,
 * a sideways drag moves the view left and right; up and down still scrolls the page. At normal size one finger
 * is left alone so the page scrolls and taps work as usual.
 */
private fun Modifier.fingerZoom(z: FingerZoom): Modifier = pointerInput(Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var totalDx = 0f
        var panning = false
        do {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            val down = event.changes.filter { it.pressed }
            if (down.size >= 2) {
                val a = down[0]; val b = down[1]
                val now = (a.position - b.position).getDistance()
                val before = (a.previousPosition - b.previousPosition).getDistance()
                if (before > 0f && now > 0f) {
                    val centroid = (a.position + b.position) / 2f
                    val previous = (a.previousPosition + b.previousPosition) / 2f
                    val newScale = (z.scale * now / before).coerceIn(1f, MAX_FINGER_ZOOM)
                    val ratio = newScale / z.scale
                    // The point between the fingers stays under them while the page grows.
                    z.tx = centroid.x - (centroid.x - z.tx) * ratio + (centroid.x - previous.x)
                    z.ty = centroid.y - (centroid.y - z.ty) * ratio + (centroid.y - previous.y)
                    z.scale = newScale
                    z.clamp(size.width.toFloat(), size.height.toFloat())
                }
                event.changes.forEach { it.consume() }
            } else if (down.size == 1 && z.scale > 1f) {
                val ch = down[0]
                val d = ch.position - ch.previousPosition
                totalDx += d.x
                if (!panning && abs(totalDx) > viewConfiguration.touchSlop && abs(d.x) >= abs(d.y)) panning = true
                if (panning) {
                    z.tx += d.x
                    z.clamp(size.width.toFloat(), size.height.toFloat())
                    ch.consume()
                }
            }
        } while (event.changes.any { it.pressed })
    }
}

/** The large photo: the width of the screen, a 16:11 box that grows with the phone (capped on tablets). */
private fun Modifier.heroModifier(): Modifier =
    fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 180.dp, max = 420.dp)
        .aspectRatio(16f / 11f).clip(RoundedCornerShape(16.dp))

/** How long each large photo stays before the gallery moves to the next one. */
private const val HERO_AUTO_SCROLL_MS = 4000L

/**
 * The large photo(s). One photo: just the photo. Two or more: swipe sideways between them, they also
 * move on by themselves every [HERO_AUTO_SCROLL_MS] (paused while a finger is on it), with dots underneath.
 * [selectedRequest] (photo number, tap count) lets the thumbnail strip jump to a photo.
 */
@Composable
private fun HeroGallery(
    images: List<String>,
    fallback: String?,
    name: String,
    selectedRequest: Pair<Int, Int>,
    onPageChange: (Int) -> Unit,
    onView: (String) -> Unit
) {
    val urls = images.ifEmpty { listOfNotNull(fallback) }
    if (urls.size <= 1) {
        val u = urls.firstOrNull()
        PlantPhoto(u, name, Modifier.heroModifier().clickable(enabled = u != null) { u?.let(onView) }, maxPx = 1024)
        return
    }
    val pager = rememberPagerState(pageCount = { urls.size })
    val dragged by pager.interactionSource.collectIsDraggedAsState()

    // A thumbnail was tapped.
    LaunchedEffect(selectedRequest) { if (selectedRequest.first in urls.indices) pager.animateScrollToPage(selectedRequest.first) }
    // Tell the strip which photo is showing.
    LaunchedEffect(pager.currentPage) { onPageChange(pager.currentPage) }
    // Auto scroll: wait, move on, repeat. Restarts after every swipe, so it never fights the finger.
    LaunchedEffect(pager.currentPage, dragged, urls.size) {
        if (dragged) return@LaunchedEffect
        delay(HERO_AUTO_SCROLL_MS)
        pager.animateScrollToPage((pager.currentPage + 1) % urls.size)
    }

    Box(Modifier.fillMaxWidth()) {
        HorizontalPager(
            state = pager, modifier = Modifier.fillMaxWidth(), beyondViewportPageCount = 1,
            pageSpacing = 0.dp
        ) { page ->
            PlantPhoto(
                urls[page], name,
                Modifier.heroModifier().clickable { onView(urls[page]) },
                maxPx = 1024
            )
        }
        Row(
            Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp)
                .background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(50))
                .padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            urls.indices.forEach { i ->
                Box(
                    Modifier.size(if (i == pager.currentPage) 8.dp else 6.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = if (i == pager.currentPage) 1f else 0.55f))
                )
            }
        }
    }
}

@Composable
private fun Message(title: String, body: String, action: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        action?.invoke()
    }
}

@Composable
private fun Pill(text: String, container: Color, content: Color) {
    Surface(shape = RoundedCornerShape(50), color = container) {
        Text(text, Modifier.padding(horizontal = 12.dp, vertical = 5.dp), style = MaterialTheme.typography.labelLarge, color = content)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProfileBody(
    p: PlantProfileData,
    fallbackHero: String?,
    votes: VotesController,
    onHidden: () -> Unit,
    onView: (String) -> Unit,
    onRequestChange: ((String) -> Unit)?,
    onOpenBotanist: (String) -> Unit
) {
    val c = MaterialTheme.colorScheme
    var heroRequest by remember { mutableStateOf(-1 to 0) }
    var heroShowing by remember { mutableStateOf(0) }
    val primary = p.descriptions.firstOrNull { it.isPrimary } ?: p.descriptions.firstOrNull()
    val others = p.descriptions.filter { it !== primary }
    val tox = p.toxicityLevel?.takeIf { it.isNotBlank() && it != "none" }
    // How the other contributors' boxes are ordered: "recent" (newest first) or "upvoted" (most up votes first).
    // The contributor's name is no longer a sort (A to Z): type it in the search box instead.
    var sort by remember { mutableStateOf("recent") }
    var query by remember { mutableStateOf("") }
    // The boxes scroll inside their own container; this state lets trapScroll keep that scroll from moving the page.
    val innerScroll = rememberScrollState()

    // Photos: the large photo swipes (and moves by itself) through all of them; the strip below jumps to one.
    // Tap the large photo to view it full size.
    HeroGallery(
        images = p.images, fallback = fallbackHero, name = p.name,
        selectedRequest = heroRequest, onPageChange = { heroShowing = it }, onView = onView
    )
    if (p.images.size > 1) {
        HScroll(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
            p.images.forEachIndexed { i, u ->
                PlantPhoto(
                    u, p.name,
                    Modifier.size(72.dp).clip(RoundedCornerShape(10.dp))
                        .alpha(if (i == heroShowing) 1f else 0.6f)
                        .clickable { heroRequest = i to (heroRequest.second + 1); if (i == heroShowing) onView(u) }
                )
            }
        }
    }

    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(p.name, style = MaterialTheme.typography.headlineSmall, color = c.onSurface)
            if (p.scientificName.isNotBlank())
                Text(p.scientificName, style = MaterialTheme.typography.titleSmall, color = c.onSurfaceVariant)
            p.added?.let { Text("Added $it", style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant) }
        }

        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (p.typeLabel.isNotBlank()) Pill(p.typeLabel, c.secondaryContainer, c.onSecondaryContainer)
            when (tox) {
                "mild" -> Pill("Mild toxicity", MaterialTheme.extraColors.pillMild.background, MaterialTheme.extraColors.pillMild.content)
                "moderate" -> Pill("Moderate toxicity", MaterialTheme.extraColors.pillModerate.background, MaterialTheme.extraColors.pillModerate.content)
                "severe" -> Pill("Severe toxicity", MaterialTheme.extraColors.pillSevere.background, MaterialTheme.extraColors.pillSevere.content)
                null -> {}
                else -> Pill("Toxicity: $tox", c.errorContainer, c.onErrorContainer)
            }
        }

        if (primary != null && primary.author != null) {
            ContributorByline(primary, onOpenBotanist, onView)
        }
        if (primary != null) EditedLine(primary, c.onSurfaceVariant, onOpenBotanist)

        // Thumbs sit ABOVE the description text, for the primary one (here, under the byline) and for every
        // contributor box below (under the author's name), so they are always in the same place.
        DescriptionVoteBar(votes, primary?.descriptionId, onHidden, onRequestChange)

        Section("What it looks like", primary?.looks, "No description recorded yet.")
        Section("Common uses", primary?.uses)
        Section("Health benefits", primary?.benefits)

        // A harmful plant warns from its toxicity level even when no botanist wrote notes.
        val warnings = listOfNotNull(
            tox?.let { "${p.typeLabel.ifBlank { "This plant" }} — Toxicity level: $it." },
            p.cautionNote.ifBlank { null },
            primary?.harmful?.ifBlank { null }
        )
        if (warnings.isNotEmpty()) {
            Card(colors = CardDefaults.cardColors(containerColor = c.errorContainer), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Things to watch out for", style = MaterialTheme.typography.titleSmall, color = c.onErrorContainer)
                    warnings.forEach { RichTextView(it, style = MaterialTheme.typography.bodyMedium, color = c.onErrorContainer) }
                }
            }
        } else {
            Section("Things to watch out for", null, "Nothing hazardous recorded.")
        }

        // One colored box per other contributor; the color follows their place in the list (the primary has color 0).
        val shown = others.withIndex().filter { (_, d) ->
            d.looks.isNotBlank() || d.uses.isNotBlank() || d.benefits.isNotBlank() || d.harmful.isNotBlank()
        }
        // The color stays with the contributor (their original place in the list), whatever the order.
        val ups = votes.summary?.byId
        // Search by contributor name: anything the name contains, any capitals.
        val q = query.trim()
        val found = if (q.isEmpty()) shown else shown.filter { (_, d) -> d.author.orEmpty().contains(q, ignoreCase = true) }
        val boxes = when (sort) {
            "upvoted" -> found.sortedWith(
                compareByDescending<IndexedValue<ProfileDescription>> { ups?.get(it.value.descriptionId ?: "")?.up ?: 0 }
                    .thenByDescending { it.value.createdAt.orEmpty() }
            )
            else -> found.sortedByDescending { it.value.createdAt.orEmpty() }
        }
        if (shown.isNotEmpty()) {
            HorizontalDivider()
            Text("More details from other contributors", style = MaterialTheme.typography.titleMedium, color = c.onSurface)
            if (shown.size > 1) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    FilterChip(selected = sort == "recent", onClick = { sort = "recent" }, label = { Text("Most recent") })
                    FilterChip(selected = sort == "upvoted", onClick = { sort = "upvoted" }, label = { Text("Most upvoted") })
                }
                NameSearchField(query, { query = it }, "Search by contributor name")
            }
            // The boxes live in their own scrolling container, so a plant with many contributions does not
            // make the whole page endless: scroll inside it to read them all.
            val maxHeight = (LocalConfiguration.current.screenHeightDp * 0.6f).dp
            if (boxes.isEmpty()) {
                Text(
                    "No contributor matches “$q”.",
                    style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
                )
            }
            if (boxes.isNotEmpty()) Surface(
                shape = MaterialTheme.shapes.medium,
                color = c.surfaceVariant.copy(alpha = 0.25f),
                border = BorderStroke(1.dp, c.outlineVariant),
                // trapScroll: at the top or bottom of this list the drag stops here and does not move the page.
                modifier = Modifier.fillMaxWidth().trapScroll(innerScroll)
            ) {
              Column(
                Modifier.fillMaxWidth().heightIn(max = maxHeight).verticalScroll(innerScroll).padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
              ) {
              boxes.forEach { (i, d) ->
                ContributorBox(MaterialTheme.extraColors.contributor(i + 1)) { colors ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Avatar(
                            d.author, d.authorPhotoUrl, 32.dp, colors.accent, colors.fg,
                            // Tap the picture to see it large; with no picture it opens the profile like the name does.
                            onClick = d.authorPhotoUrl?.let { u -> { onView(u) } } ?: d.authorId?.let { id -> { onOpenBotanist(id) } }
                        )
                        PersonLink(
                            d.author ?: "A contributor", d.authorId, colors.fg,
                            MaterialTheme.typography.titleSmall, onOpenBotanist
                        )
                    }
                    d.specialization?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = colors.fg.copy(alpha = 0.8f))
                    }
                    EditedLine(d, colors.fg.copy(alpha = 0.9f), onOpenBotanist)
                    if (d.descriptionId != null) {
                        CompositionLocalProvider(LocalContentColor provides colors.fg) {
                            DescriptionVoteBar(votes, d.descriptionId, onHidden, onRequestChange)
                        }
                    }
                    if (d.looks.isNotBlank()) BoxSection("What it looks like", d.looks, colors)
                    if (d.uses.isNotBlank()) BoxSection("Common uses", d.uses, colors)
                    if (d.benefits.isNotBlank()) BoxSection("Health benefits", d.benefits, colors)
                    if (d.harmful.isNotBlank()) BoxSection("Things to watch out for", d.harmful, colors)
                }
              }
              }
            }
            if (boxes.size > 1) {
                Text(
                    "${boxes.size} contributions" + (if (q.isNotEmpty()) " match “$q”" else "") + ". Scroll inside the box to see them all.",
                    style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
                )
            }
        }

        HorizontalDivider()
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            PeopleRow("Recorded by", p.recordedBy, onOpenBotanist, onView)
            PeopleRow("Reviewed by", p.reviewedBy, onOpenBotanist, onView)
            PeopleRow("Reported by", p.reportedBy, onOpenBotanist, onView)
            Text("Quantity on record: ${p.quantity ?: "—"}", style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
        }
    }
}

@Composable
private fun Section(title: String, body: String?, empty: String = "No information recorded yet.") {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
        if (body.isNullOrBlank()) Text(empty, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else RichTextView(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
    }
}

/** "Primary description by NAME" (the plant's first description) with the author's picture, in the first contributor color. NAME is a tappable link. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ContributorByline(d: ProfileDescription, onOpen: (String) -> Unit, onView: (String) -> Unit) {
    val colors = MaterialTheme.extraColors.contributor(0)
    Surface(
        // A pill when it fits on one line; the corners soften when a big font or a long name makes it wrap.
        shape = RoundedCornerShape(24.dp),
        color = colors.bg,
        border = BorderStroke(1.dp, colors.accent),
        modifier = Modifier.widthIn(max = 600.dp)
    ) {
        Row(
            Modifier.padding(start = 6.dp, end = 14.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Avatar(
                d.author, d.authorPhotoUrl, 32.dp, colors.accent, colors.fg,
                onClick = d.authorPhotoUrl?.let { u -> { onView(u) } } ?: d.authorId?.let { id -> { onOpen(id) } }
            )
            // Label and name flow together and wrap onto the next line instead of running off the screen.
            FlowRow(
                Modifier.weight(1f, fill = false),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalArrangement = Arrangement.spacedBy(0.dp),
                itemVerticalAlignment = Alignment.CenterVertically
            ) {
                Text("Primary description by", style = MaterialTheme.typography.labelLarge, color = colors.fg)
                PersonLink(d.author.orEmpty(), d.authorId, colors.fg, MaterialTheme.typography.labelLarge, onOpen)
            }
        }
    }
}

/**
 * "Edited by NAME · November 5, 2026, 3:42 PM". Nothing when the description was never edited. The server keeps only
 * the LATEST edit, so a new edit by someone else replaces both the name and the time. The name opens that person's profile.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun EditedLine(d: ProfileDescription, color: Color, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    if (d.editedAt.isNullOrBlank()) return
    val whenText = niceDateTime(d.editedAt)
    FlowRow(
        modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
        itemVerticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Filled.Edit, contentDescription = null, tint = color, modifier = Modifier.size(14.dp))
        Text("Edited", style = MaterialTheme.typography.labelMedium, color = color, fontWeight = FontWeight.SemiBold)
        if (!d.editedBy.isNullOrBlank()) {
            Text("by", style = MaterialTheme.typography.labelMedium, color = color)
            PersonLink(d.editedBy, d.editedById, color, MaterialTheme.typography.labelMedium, onOpen)
        }
        if (whenText.isNotBlank()) Text("· $whenText", style = MaterialTheme.typography.labelMedium, color = color)
    }
}

/** One-line search box with a clear button: the app's "search by name" field. */
@Composable
internal fun NameSearchField(value: String, onChange: (String) -> Unit, label: String, modifier: Modifier = Modifier) {
    OutlinedTextField(
        value = value,
        onValueChange = { onChange(it.take(60)) },
        modifier = modifier.fillMaxWidth(),
        singleLine = true,
        label = { Text(label) },
        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
        trailingIcon = {
            if (value.isNotEmpty()) IconButton(onClick = { onChange("") }) {
                Icon(Icons.Filled.Close, contentDescription = "Clear search")
            }
        },
        shape = MaterialTheme.shapes.small
    )
}

/** A contributor's box: tinted background, an accent edge on the left, text in the box's own color. */
@Composable
private fun ContributorBox(colors: ContributorPalette, content: @Composable ColumnScope.(ContributorPalette) -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = colors.bg,
        contentColor = colors.fg,
        border = BorderStroke(1.dp, colors.accent),
        modifier = Modifier.fillMaxWidth()
    ) {
        // The accent edge is drawn behind the content instead of using IntrinsicSize.Min, so the box is measured once
        // and anything inside it that changes size (the vote panel) lays out correctly.
        val edge = colors.accent
        Column(
            Modifier.fillMaxWidth()
                .drawBehind { drawRect(edge, size = Size(6.dp.toPx(), size.height)) }
                .padding(start = 20.dp, top = 14.dp, end = 14.dp, bottom = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) { this.content(colors) }
    }
}

@Composable
private fun BoxSection(title: String, body: String, colors: ContributorPalette) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            title.uppercase(), style = MaterialTheme.typography.labelSmall,
            color = colors.fg.copy(alpha = 0.85f), fontWeight = FontWeight.Bold
        )
        RichTextView(body, style = MaterialTheme.typography.bodyMedium, color = colors.fg)
    }
}

/**
 * Names with the role the SERVER gave them (never guessed from the name). The label is a small heading and every
 * person gets their own line with the same layout: picture (or the person's initial), then the name, then the role.
 * A name with an accountId is an underlined link to that person's profile; one without is plain text, but still has
 * its picture or initial so the lines line up. Nobody named: row hidden.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PeopleRow(label: String, people: List<ProfilePerson>, onOpen: (String) -> Unit, onView: (String) -> Unit) {
    if (people.isEmpty()) return
    val c = MaterialTheme.colorScheme
    val style = MaterialTheme.typography.bodyMedium
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = c.onSurfaceVariant)
        people.forEach { person ->
            val role = when (person.role) {
                "admin" -> "Administrator"
                "superadmin" -> "Superadministrator"
                else -> null
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Avatar(
                    person.name, person.photoUrl, 28.dp, c.primary, c.onSurface,
                    // Tap the picture to see it large; with no picture it opens the profile like the name does.
                    onClick = person.photoUrl?.let { u -> { onView(u) } } ?: person.accountId?.let { id -> { onOpen(id) } }
                )
                FlowRow(
                    Modifier.weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    itemVerticalAlignment = Alignment.CenterVertically
                ) {
                    PersonLink(person.name, person.accountId, c.primary, style, onOpen)
                    if (role != null) Text("($role)", style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                }
            }
        }
    }
}
