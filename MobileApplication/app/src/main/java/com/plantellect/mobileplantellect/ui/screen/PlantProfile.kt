package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel

/**
 * The plant's profile, loaded from GET /api/plants/:plantId: photos, names, category and
 * toxicity, what it looks like, uses, benefits, things to watch out for, other botanists'
 * descriptions, and who recorded / reviewed / reported it. Full screen over the library.
 */
@Composable
fun PlantProfileDialog(plantId: String, fallbackName: String, heroUrl: String?, vm: LibraryViewModel, onClose: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val client = (LocalContext.current.applicationContext as PlantellectApp).container.network.okHttpClient
    var attempt by remember { mutableStateOf(0) }
    val state by produceState<ProfileLoad>(ProfileLoad.Loading, plantId, attempt) {
        value = ProfileLoad.Loading
        value = fetchPlantProfile(client, vm, plantId, force = attempt > 0)
    }
    var viewing by remember { mutableStateOf<String?>(null) }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = c.background) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding()) {
                TextButton(onClose, Modifier.statusBarsPadding().padding(horizontal = 8.dp)) { Text("← Back to library") }

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
                        Button({ attempt++ }) { Text("Try again") }
                    }
                    is ProfileLoad.Ready -> ProfileBody(s.data, heroUrl) { viewing = it }
                }
            }
        }
    }

    viewing?.let { url ->
        Dialog(onDismissRequest = { viewing = null }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Surface(Modifier.fillMaxSize(), color = Color.Black.copy(alpha = 0.92f)) {
                Box(Modifier.fillMaxSize().clickable { viewing = null }) {
                    PlantPhoto(
                        url, fallbackName, Modifier.fillMaxSize().padding(16.dp),
                        maxPx = 2048, scale = ContentScale.Fit, placeholder = false
                    )
                    TextButton({ viewing = null }, Modifier.align(Alignment.TopEnd).statusBarsPadding()) {
                        Text("Close", color = Color.White)
                    }
                }
            }
        }
    }
}

private fun Modifier.heroModifier(): Modifier =
    fillMaxWidth().padding(horizontal = 16.dp).height(240.dp).clip(RoundedCornerShape(16.dp))

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
private fun ProfileBody(p: PlantProfileData, fallbackHero: String?, onView: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val hero = p.images.firstOrNull() ?: fallbackHero
    val primary = p.descriptions.firstOrNull { it.isPrimary } ?: p.descriptions.firstOrNull()
    val others = p.descriptions.filter { it !== primary }
    val tox = p.toxicityLevel?.takeIf { it.isNotBlank() && it != "none" }

    // Photos: the first one large, the rest as a strip. Tap to view full size.
    PlantPhoto(hero, p.name, Modifier.heroModifier().clickable(enabled = hero != null) { hero?.let(onView) }, maxPx = 1024)
    if (p.images.size > 1) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            p.images.forEach { u ->
                PlantPhoto(u, p.name, Modifier.size(72.dp).clip(RoundedCornerShape(10.dp)).clickable { onView(u) })
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
                "mild" -> Pill("Mild toxicity", Color(0xFFF2C94C), Color.Black)
                "moderate" -> Pill("Moderate toxicity", Color(0xFFF2994A), Color.Black)
                "severe" -> Pill("Severe toxicity", Color(0xFFEB5757), Color.White)
                null -> {}
                else -> Pill("Toxicity: $tox", c.errorContainer, c.onErrorContainer)
            }
        }

        if (primary != null && p.descriptions.size > 1 && primary.author != null) {
            Text("Primary description by ${primary.author}", style = MaterialTheme.typography.labelLarge, color = c.primary)
        }

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
                    warnings.forEach { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onErrorContainer) }
                }
            }
        } else {
            Section("Things to watch out for", null, "Nothing hazardous recorded.")
        }

        val boxes = others.filter { it.looks.isNotBlank() || it.uses.isNotBlank() || it.benefits.isNotBlank() || it.harmful.isNotBlank() }
        if (boxes.isNotEmpty()) {
            HorizontalDivider()
            Text("More details from other botanists", style = MaterialTheme.typography.titleMedium, color = c.onSurface)
            boxes.forEach { d ->
                Card(colors = CardDefaults.cardColors(containerColor = c.surfaceVariant), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Column {
                            Text(d.author ?: "A botanist", style = MaterialTheme.typography.titleSmall, color = c.primary)
                            d.specialization?.takeIf { it.isNotBlank() }?.let {
                                Text(it, style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                            }
                        }
                        if (d.looks.isNotBlank()) Block("What it looks like", d.looks)
                        if (d.uses.isNotBlank()) Block("Common uses", d.uses)
                        if (d.benefits.isNotBlank()) Block("Health benefits", d.benefits)
                        if (d.harmful.isNotBlank()) Block("Things to watch out for", d.harmful, warn = true)
                    }
                }
            }
        }

        HorizontalDivider()
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PeopleRow("Recorded by", p.recordedBy)
            PeopleRow("Reviewed by", p.reviewedBy)
            PeopleRow("Reported by", p.reportedBy)
            Text("Quantity on record: ${p.quantity ?: "—"}", style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
        }
    }
}

@Composable
private fun Section(title: String, body: String?, empty: String = "No information recorded yet.") {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
        if (body.isNullOrBlank()) Text(empty, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun Block(title: String, body: String, warn: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            title, style = MaterialTheme.typography.labelLarge,
            color = if (warn) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
        )
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
    }
}

/** Names with the role the SERVER gave them (never guessed from the name). Nobody named: row hidden. */
@Composable
private fun PeopleRow(label: String, people: List<ProfilePerson>) {
    if (people.isEmpty()) return
    val text = people.joinToString(", ") { person ->
        person.name + when (person.role) {
            "botanist" -> " (Verified Botanist)"
            "admin" -> " (Administrator)"
            "superadmin" -> " (Superadministrator)"
            else -> ""
        }
    }
    Text("$label: $text", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}