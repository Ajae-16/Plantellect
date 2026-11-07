package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.ThumbDown
import androidx.compose.material.icons.filled.ThumbUp
import androidx.compose.material.icons.outlined.ThumbDown
import androidx.compose.material.icons.outlined.ThumbUp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.plantellect.mobileplantellect.data.remote.dto.DescriptionVoteState
import com.plantellect.mobileplantellect.data.remote.dto.VoteReason
import com.plantellect.mobileplantellect.data.remote.dto.VoteResult
import com.plantellect.mobileplantellect.data.remote.dto.VoteSummary
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

// ---------------------------------------------------------------------------
// Community votes on descriptions (server: routes/description-votes.js)
//
// The calls, the wire shapes and the error text live in the data layer:
//   data/remote/VotesApi.kt, data/repository/DescriptionVoteRepository.kt, models in dto/PublicDtos.kt,
// reached through LibraryViewModel.voteSummary / voteUp / voteDown / voteRetract. Only the state the
// screen draws is kept here. The server enforces every rule (own description, hidden description,
// reasons, note length); the app shows the server's error text.
// ---------------------------------------------------------------------------

/** Holds the vote state for ONE plant's profile and sends votes. Create with [rememberVotes]. */
@Stable
class VotesController(
    @Suppress("unused") private val client: OkHttpClient,   // no longer used: the view-model does the calls
    private val vm: LibraryViewModel,
    private val plantId: String,
    private val scope: CoroutineScope
) {
    var summary by mutableStateOf<VoteSummary?>(null)
        private set

    /** The description whose request is in flight, so its buttons can be disabled. */
    var busyId by mutableStateOf<String?>(null)
        private set

    fun refresh() {
        scope.launch { vm.voteSummary(plantId)?.let { summary = it } }
    }

    private fun submit(descriptionId: String, onDone: (VoteResult) -> Unit, send: suspend () -> VoteResult) {
        if (busyId != null) return
        busyId = descriptionId
        scope.launch {
            val result = send()
            busyId = null
            // Down counts, reasons and notes change for everyone, so re-read instead of patching.
            if (result is VoteResult.Ok && !result.hidden) refresh()
            onDone(result)
        }
    }

    fun up(descriptionId: String, onDone: (VoteResult) -> Unit) =
        submit(descriptionId, onDone) { vm.voteUp(plantId, descriptionId) }

    fun down(descriptionId: String, reasonCode: String, note: String?, onDone: (VoteResult) -> Unit) =
        submit(descriptionId, onDone) { vm.voteDown(plantId, descriptionId, reasonCode, note) }

    fun retract(descriptionId: String, onDone: (VoteResult) -> Unit) =
        submit(descriptionId, onDone) { vm.voteRetract(plantId, descriptionId) }
}

@Composable
fun rememberVotes(client: OkHttpClient, vm: LibraryViewModel, plantId: String, reloadKey: Int = 0): VotesController {
    val scope = rememberCoroutineScope()
    val controller = remember(plantId) { VotesController(client, vm, plantId, scope) }
    LaunchedEffect(plantId, reloadKey) { controller.refresh() }
    return controller
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/**
 * Thumbs up / down for one description.
 *  - up:   one tap casts the upvote (no Submit step). Tapping it again, once cast, offers "Remove my vote".
 *  - down: tapping the thumb opens a panel with the premade reasons as chips (plus a note box for "Other"), then
 *          "Submit downvote" / Cancel. Picking a reason scrolls the Submit button into view.
 * Tapping a downvote you already cast offers "Remove my vote". The "..." menu next to the thumbs holds
 * "Request change" (only when [onRequestChange] is given: it opens the change form for THIS description) and
 * "Votes summary", which opens the table (totals, reasons counted, voters' notes, no names).
 *
 * [onHidden] runs when enough down votes just hid this description: reload the profile.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun DescriptionVoteBar(
    votes: VotesController,
    descriptionId: String?,
    onHidden: () -> Unit,
    onRequestChange: ((descriptionId: String) -> Unit)? = null,
    modifier: Modifier = Modifier
) {
    val id: String = descriptionId ?: return
    val summary = votes.summary ?: return
    val st = summary.byId[id] ?: return
    val c = MaterialTheme.colorScheme

    /** What is picked but not yet submitted: "up", "down" or nothing. */
    var choice by remember(id) { mutableStateOf<String?>(null) }
    var tableOpen by remember(id) { mutableStateOf(false) }
    var menuOpen by remember(id) { mutableStateOf(false) }
    var reason by remember(id) { mutableStateOf<String?>(null) }
    var note by remember(id) { mutableStateOf("") }
    var message by remember(id) { mutableStateOf<String?>(null) }
    val submitDownRequester = remember(id) { BringIntoViewRequester() }
    // Once a reason is picked, bring "Submit downvote" into view (after the note box for "Other" has been laid out).
    LaunchedEffect(reason) {
        if (reason != null) { delay(120); runCatching { submitDownRequester.bringIntoView() } }
    }

    val busy = votes.busyId == id
    val locked = st.own || busy
    // The thumbs show the pick while choosing, otherwise the vote that is already cast.
    val shown = choice ?: st.myVote

    fun done(r: VoteResult) {
        when (r) {
            is VoteResult.Ok -> {
                message = null
                choice = null
                reason = null
                note = ""
                if (r.hidden) onHidden()
            }
            is VoteResult.Err -> message = r.message
        }
    }

    fun needSignIn(): Boolean {
        if (summary.signedIn) return false
        message = "Sign in to vote."
        return true
    }

    fun pick(which: String) {
        message = null
        if (needSignIn()) return
        // An upvote is cast right away. If it is already cast, the panel below offers to take it back.
        if (which == "up" && st.myVote != "up") {
            choice = null; reason = null; note = ""
            votes.up(id, ::done)
            return
        }
        // Tapping the same thumb again closes the panel.
        choice = if (choice == which) null else which
        if (which != "down") { reason = null; note = "" }
    }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            VoteButton(
                active = shown == "up", count = st.up, enabled = !locked,
                filled = Icons.Filled.ThumbUp, outlined = Icons.Outlined.ThumbUp,
                description = "Upvote: this is helpful",
                activeContainer = c.primary, activeContent = c.onPrimary
            ) { pick("up") }
            VoteButton(
                active = shown == "down", count = st.down, enabled = !locked,
                filled = Icons.Filled.ThumbDown, outlined = Icons.Outlined.ThumbDown,
                description = "Downvote: something is wrong",
                activeContainer = c.error, activeContent = c.onError
            ) { pick("down") }
            // The three dots: Request change, Votes summary.
            Box {
                IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(40.dp)) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "More for this description")
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    if (onRequestChange != null) {
                        DropdownMenuItem(
                            text = { Text("Request change") },
                            onClick = { menuOpen = false; onRequestChange(id) }
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(if (tableOpen) "Hide votes summary" else "Votes summary") },
                        onClick = { menuOpen = false; tableOpen = !tableOpen }
                    )
                }
            }
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        }

        val hint = message ?: if (st.own) "You wrote this description, so you can't vote on it." else null
        if (hint != null) {
            Text(
                hint, style = MaterialTheme.typography.bodySmall,
                color = if (message != null) c.error else c.onSurfaceVariant
            )
        }

        // Plain conditionals, no AnimatedVisibility: animated size inside the contributor boxes (which are measured
        // by intrinsic size) was never re-measured, so the panel and its Submit button stayed hidden until some
        // other change (like opening the votes summary) forced a new layout.
        val pending = choice
        if (pending != null && !st.own) {
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = c.surface, contentColor = c.onSurface,
                border = BorderStroke(1.dp, c.outlineVariant)
            ) {
                Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    when {
                        // Already cast this way: the only thing left to do is take it back.
                        pending == st.myVote -> {
                            Text(
                                if (pending == "up") "You upvoted this description." else "You downvoted this description.",
                                style = MaterialTheme.typography.titleSmall
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                PlantButton(enabled = !busy, onClick = { votes.retract(id, ::done) }) { Text("Remove my vote") }
                                PlantTextButton(onClick = { choice = null; message = null }) { Text("Cancel") }
                            }
                        }
                        else -> {
                            Text("What is wrong with it?", style = MaterialTheme.typography.titleSmall)
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                summary.reasons.forEach { r ->
                                    FilterChip(
                                        selected = reason == r.code,
                                        onClick = { reason = r.code; message = null },
                                        label = { Text(r.label) }
                                    )
                                }
                            }
                            if (reason == "other") {
                                LimitedOutlinedTextField(
                                    value = note,
                                    onValueChange = { note = it },
                                    maxChars = summary.noteMaxLength,
                                    modifier = Modifier.fillMaxWidth(),
                                    minLines = 3,
                                    maxLines = 6,
                                    label = "Note for the administrator",
                                    placeholder = "Say what is wrong, e.g. which fact is incorrect",
                                    showCounter = true,
                                    shape = RoundedCornerShape(12.dp)
                                )
                            }
                            Row(
                                Modifier.bringIntoViewRequester(submitDownRequester),
                                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically
                            ) {
                                PlantButton(
                                    enabled = !busy,
                                    onClick = {
                                        val code = reason
                                        when {
                                            code == null -> message = "Please choose a reason."
                                            code == "other" && note.trim().length < 3 ->
                                                message = "Please write a short note so the administrator knows what is wrong."
                                            else -> votes.down(id, code, note.trim().ifBlank { null }, ::done)
                                        }
                                    }
                                ) { Text("Submit downvote") }
                                PlantTextButton(onClick = { choice = null; reason = null; note = ""; message = null }) { Text("Cancel") }
                            }
                        }
                    }
                }
            }
        }

        if (tableOpen) VotesTable(st)
    }
}

@Composable
private fun VoteButton(
    active: Boolean,
    count: Int,
    enabled: Boolean,
    filled: ImageVector,
    outlined: ImageVector,
    description: String,
    activeContainer: androidx.compose.ui.graphics.Color,
    activeContent: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit
) {
    val c = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(50),
        color = if (active) activeContainer else androidx.compose.ui.graphics.Color.Transparent,
        contentColor = if (active) activeContent else c.onSurfaceVariant,
        border = if (active) null else BorderStroke(1.dp, c.outlineVariant),
        modifier = Modifier.heightIn(min = 40.dp)
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Icon(if (active) filled else outlined, contentDescription = description, modifier = Modifier.size(20.dp))
            Text("$count", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        }
    }
}

/** Totals first, then why people downvoted. No names: the server keeps voters admin-only. */
@Composable
private fun VotesTable(st: DescriptionVoteState) {
    val c = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(12.dp), color = c.surfaceVariant.copy(alpha = 0.5f), border = BorderStroke(1.dp, c.outlineVariant)) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Votes summary", style = MaterialTheme.typography.labelLarge, color = c.onSurface)
            TableRow("Upvote", st.up.toString(), "Helpful", c.primary, bold = true)
            TableRow("Downvote", st.down.toString(), "Not good", c.error, bold = true)
            st.reasons.forEach { TableRow("   ↳ Downvote", it.count.toString(), it.label, c.onSurfaceVariant) }
            st.notes.forEach { TableRow("   ↳ Note", "1", "“$it”", c.onSurfaceVariant) }
        }
    }
}

@Composable
private fun TableRow(kind: String, n: String, detail: String, kindColor: androidx.compose.ui.graphics.Color, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(
            kind, Modifier.weight(0.34f), color = kindColor, fontSize = 13.sp,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal
        )
        Text(n, Modifier.weight(0.12f), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)
        Text(detail, Modifier.weight(0.54f), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface)
    }
}