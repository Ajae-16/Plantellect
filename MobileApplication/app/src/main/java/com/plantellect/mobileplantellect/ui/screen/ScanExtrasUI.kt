package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.plantellect.mobileplantellect.viewmodel.ContributePhase
import com.plantellect.mobileplantellect.viewmodel.ContributionUi
import com.plantellect.mobileplantellect.viewmodel.MessageTone
import com.plantellect.mobileplantellect.viewmodel.ReportUi

// ============================================================================ Help improve the ML

/**
 * Shown only when the server sent a contribution offer for the photo on screen. The card decides
 * nothing: it shows the choices and then the server's own answer.
 */
@Composable
fun ContributionCard(
    modifier: Modifier = Modifier,
    ui: ContributionUi,
    onHelp: () -> Unit,
    onClose: () -> Unit,
    /** True while "Help improve" is off in Settings and the person has not hidden the hint. */
    showSettingsHint: Boolean = false,
    /** The person confirmed "Don't show this again" on the hint. */
    onHideHint: () -> Unit = {}
) {
    val colors = MaterialTheme.colorScheme
    var confirmHide by remember { mutableStateOf(false) }
    val asking = ui.phase == ContributePhase.OFFER || ui.phase == ContributePhase.SENDING
    val sending = ui.phase == ContributePhase.SENDING

    Card(
        modifier = modifier,
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.cardColors(containerColor = colors.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("Help improve the plant model?", style = MaterialTheme.typography.titleMedium, color = colors.onSurface)

            if (asking) {
                Text(
                    "You can share this photo of ${ui.speciesName} to help the model learn.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurfaceVariant
                )
            }
            ui.message?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = when (ui.tone) {
                        MessageTone.ERROR -> colors.error
                        MessageTone.SUCCESS -> colors.primary
                        MessageTone.INFO -> colors.onSurfaceVariant
                    }
                )
            }

            if (asking) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PlantButton(onClick = onHelp, enabled = !sending, modifier = Modifier.weight(1f)) {
                        if (sending) {
                            CircularProgressIndicator(
                                modifier = Modifier.padding(end = 8.dp).size(18.dp),
                                strokeWidth = 2.dp,
                                color = colors.onPrimary
                            )
                        }
                        Text(if (sending) "Sending…" else "Help improve")
                    }
                    PlantOutlinedButton(onClick = onClose, enabled = !sending, modifier = Modifier.weight(1f)) {
                        Text("Skip")
                    }
                }
                Text(
                    "Used only to train the plant model. Never shown publicly.",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant
                )
                if (showSettingsHint) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "Tired of tapping this? Turn on \"Help improve\" in Settings to always contribute.",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.onSurfaceVariant,
                            modifier = Modifier.weight(1f)
                        )
                        PlantTextButton(onClick = { confirmHide = true }, enabled = !sending) { Text("Don't show this again") }
                    }
                }
            } else {
                PlantOutlinedButton(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("Close") }
            }
        }
    }

    if (confirmHide) {
        AlertDialog(
            onDismissRequest = { confirmHide = false },
            title = { Text("Always help improve") },
            text = { Text("You can always turn on \"Help improve\" in Settings under Privacy, so your scans are contributed without asking.") },
            confirmButton = {
                PlantTextButton(onClick = {
                    confirmHide = false
                    onHideHint()
                }) { Text("Got it") }
            },
            dismissButton = { PlantTextButton(onClick = { confirmHide = false }) { Text("Cancel") } }
        )
    }
}

// ============================================================================ Not identified?

/** Tick-box clues. Ticking only adds text to the note, so someone without the words can still describe it. */
private val REPORT_CHECKLIST: List<Pair<String, List<String>>> = listOf(
    "Leaves" to listOf(
        "compound leaves (many small leaflets)", "simple leaves", "leaves in pairs (opposite)",
        "leaves one by one (alternate)", "broad leaves", "narrow or needle-like leaves", "thorny or spiny"
    ),
    "Flowers and fruit" to listOf("has flowers", "has fruit, berries or pods", "no flowers or fruit visible"),
    "Growth" to listOf("tree", "shrub", "vine or climber", "small herb or ground cover", "grass-like"),
    "Other clues" to listOf(
        "hairy or fuzzy surface", "waxy or shiny surface", "milky sap", "strong smell",
        "growing on a wall or rock", "growing in water or wet ground"
    )
)

/**
 * "The model could not name it, but I know it is a plant." The scanned photo is used, so there is
 * nothing to upload. The summary is loaded the first time the card is opened ([onOpened]).
 * After a report is sent it can be withdrawn from here ([onWithdraw]); the server decides if it is too late.
 *
 * Each checklist label (Leaves, Flowers and fruit, ...) is its own dropdown, closed by default.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
fun NotIdentifiedCard(
    modifier: Modifier = Modifier,
    ui: ReportUi,
    onOpened: () -> Unit,
    onSend: (note: String, location: String, allowContribution: Boolean) -> Unit,
    onWithdraw: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    var expanded by remember { mutableStateOf(false) }
    val ticked = remember { mutableStateListOf<String>() }
    /** Titles of the checklist dropdowns that are currently open. Empty = all closed. */
    val openGroups = remember { mutableStateListOf<String>() }
    var extra by remember { mutableStateOf("") }
    var location by remember { mutableStateOf("") }
    var allowContribution by remember { mutableStateOf(false) }

    val atCap = ui.summary?.atCap == true
    val note = buildList {
        if (ticked.isNotEmpty()) add("What I see: ${ticked.joinToString(", ")}.")
        if (extra.isNotBlank()) add(extra.trim())
    }.joinToString(" ")

    Card(
        modifier = modifier,
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.cardColors(containerColor = colors.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(
                Modifier.fillMaxWidth().hapticClickable {
                    expanded = !expanded
                    if (expanded) onOpened()
                },
                verticalArrangement = Arrangement.spacedBy(2.dp)
            ) {
                Text("Not identified?", style = MaterialTheme.typography.titleMedium, color = colors.onSurface)
                Text(
                    "Tell us about a plant the model could not name",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant
                )
            }

            // Always visible at the cap, so the person can SEE why the option is unavailable.
            if (atCap) {
                Text(
                    "You have ${ui.summary.open} open report${if (ui.summary.open == 1) "" else "s"} of " +
                            "${ui.summary.limit}. One must be reviewed or withdrawn before you can file another.",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.error
                )
            }

            if (expanded) {
                if (ui.sent) {
                    ui.message?.let {
                        Text(
                            it,
                            Modifier.shakeWhen(if (ui.isError) it else null),
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (ui.isError) colors.error else colors.primary
                        )
                    }
                    // Only while we still know which report this is. The server refuses with 409 when too late.
                    if (ui.requestId != null) {
                        PlantOutlinedButton(
                            onClick = onWithdraw,
                            enabled = !ui.withdrawing,
                            modifier = Modifier.fillMaxWidth()
                        ) { Text(if (ui.withdrawing) "Withdrawing…" else "Withdraw this report") }
                    }
                } else {
                    Text(
                        "If this really is a plant but the model could not name it, tell us. Your scanned photo " +
                                "is used for the report. A contributor picks it up and records it for you.",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onSurfaceVariant
                    )

                    Text("What do you see?", style = MaterialTheme.typography.labelLarge, color = colors.onSurface)
                    REPORT_CHECKLIST.forEach { (title, items) ->
                        ChecklistDropdown(
                            title = title,
                            items = items,
                            ticked = ticked,
                            open = title in openGroups,
                            onToggleOpen = { if (title in openGroups) openGroups.remove(title) else openGroups.add(title) },
                            enabled = !atCap && !ui.sending
                        )
                    }

                    OutlinedTextField(
                        value = extra,
                        onValueChange = { extra = it },
                        enabled = !atCap && !ui.sending,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Anything else? (optional)") },
                        placeholder = { Text("Leaf shape, smell, size, what it grows on…") },
                        minLines = 2
                    )
                    if (note.isNotBlank()) {
                        Text(
                            "The contributor will read: $note",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.onSurfaceVariant
                        )
                    }
                    OutlinedTextField(
                        value = location,
                        onValueChange = { location = it },
                        enabled = !atCap && !ui.sending,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Where did you find it? (optional)") },
                        singleLine = true
                    )

                    Row(
                        Modifier.fillMaxWidth().hapticClickable(enabled = !atCap && !ui.sending) { allowContribution = !allowContribution },
                        verticalAlignment = Alignment.Top
                    ) {
                        Checkbox(
                            checked = allowContribution,
                            onCheckedChange = hapticToggle { allowContribution = it },
                            enabled = !atCap && !ui.sending
                        )
                        Column(Modifier.padding(top = 12.dp)) {
                            Text("Also use this photo as a contribution image", style = MaterialTheme.typography.bodyMedium, color = colors.onSurface)
                            Text(
                                "Otherwise it is only used to identify the plant and is removed with the report. " +
                                        "If ticked, a contributor can attach it to the plant once it is named.",
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.onSurfaceVariant
                            )
                        }
                    }

                    ui.message?.let {
                        Text(
                            it,
                            Modifier.shakeWhen(if (ui.isError) it else null),
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (ui.isError) colors.error else colors.onSurfaceVariant
                        )
                    }

                    PlantButton(
                        onClick = { onSend(note, location, allowContribution) },
                        enabled = !atCap && !ui.sending,
                        modifier = Modifier.fillMaxWidth()
                    ) { Text(if (ui.sending) "Sending…" else "Send to a contributor") }
                }
            }
        }
    }
}

/**
 * One checklist label as its own dropdown: a header (label, how many are ticked, arrow) that opens
 * and closes its chips. Ticks are kept when it is closed, so nothing is lost by collapsing it.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun ChecklistDropdown(
    title: String,
    items: List<String>,
    ticked: MutableList<String>,
    open: Boolean,
    onToggleOpen: () -> Unit,
    enabled: Boolean
) {
    val colors = MaterialTheme.colorScheme
    val count = items.count { it in ticked }

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = colors.surfaceContainer,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .hapticClickable(onClick = onToggleOpen)
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    title,
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.onSurface,
                    modifier = Modifier.weight(1f)
                )
                if (count > 0) {
                    Text(
                        "$count selected",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.primary,
                        modifier = Modifier.padding(end = 8.dp)
                    )
                }
                Icon(
                    imageVector = if (open) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                    contentDescription = if (open) "Close $title" else "Open $title",
                    tint = colors.onSurfaceVariant
                )
            }

            AnimatedVisibility(visible = open) {
                FlowRow(
                    modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    items.forEach { item ->
                        HapticFilterChip(
                            selected = item in ticked,
                            onClick = { if (item in ticked) ticked.remove(item) else ticked.add(item) },
                            enabled = enabled,
                            label = { Text(item, style = MaterialTheme.typography.labelMedium) }
                        )
                    }
                }
            }
        }
    }
}
