package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.plantellect.mobileplantellect.data.remote.dto.*
import com.plantellect.mobileplantellect.viewmodel.ApprovalsUiState

/*
 * Profile > Pending approval.
 *
 * What still needs an approval is always on top, what is already approved or denied is at the bottom:
 *
 *   Waiting for your approval   somebody asked to change a description YOU wrote, or the plant info of a plant you
 *                               are the primary contributor of. Your approval AND an admin's are both needed; if you
 *                               decline, the change is cancelled and the admin never sees it.
 *   Still open                  requests that are not decided yet: the ones you asked for, and the ones you approved
 *                               that now wait for an admin.
 *   Approved or denied          everything that is settled, newest first. The server deletes a denied request
 *                               30 days after it was decided.
 *
 * Who is asked: changing someone else's description needs that person AND an admin; changing the plant info needs
 * the plant's primary contributor AND an admin; changing your own description (or the info of a plant you are the
 * primary contributor of) needs only an admin.
 *
 * Every card shows the same things in the same order: the plant (photo to preview), what the change is about and
 * whose description it is, WHO has answered (the contributor, then the admin) with their comment and the time, and
 * last WHAT CHANGED: each field as a "Before" box and an "After" box, with the removed words struck through and the
 * added words in bold (see [ChangeDiff]). A declined request starts with a red box that says who declined it and
 * what they wrote.
 */

private val RICH_KEYS = setOf("uses", "benefits", "harmful", "type.cautionNote")

private fun scopeTitle(m: MyApprovalDto): String = when {
    m.scope == "base" && m.owner != null -> "Change to the plant info (the primary contributor decides first)"
    m.scope == "base" -> "Change to the plant info"
    m.owner != null -> "Change to ${m.owner.name ?: "another contributor"}'s description"
    else -> "Change to your description"
}

/** "Contributor" or, for a plant-info change, "Primary contributor". */
private fun ownerLabel(role: String?): String = if (role == "primary") "Primary contributor" else "Contributor"

/** What somebody asked of ME, in words. */
private fun askedWhat(a: AwaitingApprovalDto): String =
    if (a.scope == "base") "asked to change the plant info" else "asked to change your description"

/** A request that is not decided yet, or one that is, in the one list the bottom part of the tab shows. */
private sealed interface Entry {
    val sortKey: String
    val requestStatus: String

    class Incoming(val a: AwaitingApprovalDto) : Entry {
        override val sortKey: String get() = a.reviewedAt ?: a.createdAt.orEmpty()
        override val requestStatus: String get() = a.status
    }

    class Mine(val m: MyApprovalDto) : Entry {
        override val sortKey: String get() = m.reviewedAt ?: m.createdAt.orEmpty()
        override val requestStatus: String get() = m.status
    }
}

private fun plantLine(name: String?, sci: String?): String =
    listOfNotNull(name?.takeIf { it.isNotBlank() }, sci?.takeIf { it.isNotBlank() }?.let { "($it)" }).joinToString(" ").ifBlank { "Plant" }

// ---------------------------------------------------------------------------------------------------------------
// What changed: Before / After, word by word
// ---------------------------------------------------------------------------------------------------------------

private class Tok(val text: String, val isSpace: Boolean)

private fun tokens(s: String): List<Tok> = Regex("\\s+|\\S+").findAll(s).map { Tok(it.value, it.value.isBlank()) }.toList()

/** Any run of spaces or line breaks counts as the same gap; words must match exactly. */
private fun same(x: Tok, y: Tok) = if (x.isSpace && y.isSpace) true else x.text == y.text

/**
 * Word-level difference (longest common subsequence). Returns which tokens of [a] are gone and which tokens of [b]
 * are new. A text too long to compare word by word, or one side empty, is shown plainly (nothing is marked).
 */
private fun diffMarks(a: List<Tok>, b: List<Tok>): Pair<BooleanArray, BooleanArray> {
    val goneInA = BooleanArray(a.size)
    val newInB = BooleanArray(b.size)
    if (a.none { !it.isSpace } || b.none { !it.isSpace }) return goneInA to newInB
    if (a.size.toLong() * b.size > 250_000L) return goneInA to newInB
    val dp = Array(a.size + 1) { IntArray(b.size + 1) }
    for (i in a.size - 1 downTo 0) for (j in b.size - 1 downTo 0) {
        dp[i][j] = if (same(a[i], b[j])) dp[i + 1][j + 1] + 1 else maxOf(dp[i + 1][j], dp[i][j + 1])
    }
    var i = 0
    var j = 0
    while (i < a.size && j < b.size) {
        when {
            same(a[i], b[j]) -> { i++; j++ }
            dp[i + 1][j] >= dp[i][j + 1] -> { goneInA[i] = true; i++ }
            else -> { newInB[j] = true; j++ }
        }
    }
    while (i < a.size) { goneInA[i] = true; i++ }
    while (j < b.size) { newInB[j] = true; j++ }
    return goneInA to newInB
}

private fun marked(list: List<Tok>, marks: BooleanArray, bg: Color, removed: Boolean): AnnotatedString = buildAnnotatedString {
    list.forEachIndexed { i, t ->
        if (marks[i] && !t.isSpace) {
            withStyle(
                SpanStyle(
                    background = bg, fontWeight = FontWeight.Bold,
                    textDecoration = if (removed) TextDecoration.LineThrough else null
                )
            ) { append(t.text) }
        } else append(t.text)
    }
}

private class DiffRow(
    val label: String,
    val from: String, val to: String,
    val fromText: AnnotatedString, val toText: AnnotatedString,
    val highlighted: Boolean
)

/**
 * Every field a change asks for as a "Before" box (red) and an "After" box (green). Words that were removed are
 * struck through in Before, words that were added are bold in After, so a small fix inside a long text is easy to see.
 */
@Composable
internal fun ChangeDiff(changes: Map<String, RecChange>?, modifier: Modifier = Modifier) {
    if (changes.isNullOrEmpty()) return
    val c = MaterialTheme.colorScheme
    val removedBg = c.error.copy(alpha = 0.22f)
    val addedBg = c.primary.copy(alpha = 0.25f)
    val rows = remember(changes, removedBg, addedBg) {
        changes.map { (key, ch) ->
            var from = ch.fromLabel.asText().ifEmpty { ch.from.asText() }
            var to = ch.toLabel.asText().ifEmpty { ch.to.asText() }
            if (key in RICH_KEYS) { from = plain(from); to = plain(to) }
            val a = tokens(from)
            val b = tokens(to)
            val (goneInA, newInB) = diffMarks(a, b)
            DiffRow(
                label = CHANGE_LABELS[key] ?: key,
                from = from, to = to,
                fromText = marked(a, goneInA, removedBg, removed = true),
                toText = marked(b, newInB, addedBg, removed = false),
                highlighted = goneInA.any { it } || newInB.any { it }
            )
        }
    }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("What was changed", style = MaterialTheme.typography.titleSmall, color = c.onSurface)
        rows.forEach { r ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(r.label, style = MaterialTheme.typography.labelLarge, color = c.onSurfaceVariant, fontWeight = FontWeight.SemiBold)
                DiffBlock("Before", r.fromText, r.from.isBlank(), c.error.copy(alpha = 0.08f), c.error)
                DiffBlock("After", r.toText, r.to.isBlank(), c.primary.copy(alpha = 0.10f), c.primary)
            }
        }
        if (rows.any { it.highlighted }) {
            Text(
                "Struck-through words were removed. Bold words were added.",
                style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun DiffBlock(title: String, text: AnnotatedString, empty: Boolean, container: Color, accent: Color) {
    val c = MaterialTheme.colorScheme
    Surface(
        shape = MaterialTheme.shapes.small,
        color = container,
        border = BorderStroke(1.dp, accent.copy(alpha = 0.45f)),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = accent, fontWeight = FontWeight.Bold)
            if (empty) Text("(empty)", style = MaterialTheme.typography.bodyMedium, fontStyle = FontStyle.Italic, color = c.onSurfaceVariant)
            else Text(text, style = MaterialTheme.typography.bodyMedium, color = c.onSurface)
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Who answered, and what they wrote
// ---------------------------------------------------------------------------------------------------------------

@Composable
private fun StatusChip(status: String) {
    val c = MaterialTheme.colorScheme
    val (label, color) = when (status) {
        "approved" -> "Approved" to c.primary
        "denied" -> "Declined" to c.error
        "blocked" -> "Waits for the contributor" to c.onSurfaceVariant
        "skipped" -> "Not needed" to c.onSurfaceVariant
        else -> "Waiting" to c.onSurfaceVariant
    }
    Surface(shape = RoundedCornerShape(50), color = color.copy(alpha = 0.14f)) {
        Text(
            label, Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
            style = MaterialTheme.typography.labelMedium, color = color, fontWeight = FontWeight.SemiBold
        )
    }
}

/** A comment someone left, in a quote box. [empty] = what to say when they left none (null = say nothing). */
@Composable
private fun Comment(from: String, text: String?, empty: String? = null) {
    val c = MaterialTheme.colorScheme
    val body = text?.takeIf { it.isNotBlank() }
    if (body == null && empty == null) return
    Surface(shape = MaterialTheme.shapes.small, color = c.surfaceVariant.copy(alpha = 0.55f), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(from, style = MaterialTheme.typography.labelSmall, color = c.onSurfaceVariant, fontWeight = FontWeight.Bold)
            if (body != null) Text("“$body”", style = MaterialTheme.typography.bodyMedium, color = c.onSurface)
            else Text(empty.orEmpty(), style = MaterialTheme.typography.bodyMedium, fontStyle = FontStyle.Italic, color = c.onSurfaceVariant)
        }
    }
}

/** One person's answer: their role and name, the time, a status chip, and their comment under it. */
@Composable
private fun AnswerRow(role: String, name: String?, status: String, whenIso: String?, comment: String?, noCommentText: String? = null) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                Text(
                    if (name.isNullOrBlank()) role else "$role · $name",
                    style = MaterialTheme.typography.bodyMedium, color = c.onSurface, fontWeight = FontWeight.SemiBold
                )
                if (status == "approved" || status == "denied") {
                    niceDateTime(whenIso).takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                    }
                }
            }
            StatusChip(status)
        }
        if (status == "approved" || status == "denied") Comment("COMMENT", comment, noCommentText)
    }
}

/** The red box on top of a declined request: who declined it, when, and what they wrote. */
@Composable
private fun DeclinedBanner(title: String, detail: String?, whenIso: String?, comment: String?, commentLabel: String) {
    val c = MaterialTheme.colorScheme
    Surface(
        shape = MaterialTheme.shapes.small,
        color = c.errorContainer.copy(alpha = 0.55f),
        border = BorderStroke(1.dp, c.error.copy(alpha = 0.5f)),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = c.onErrorContainer, fontWeight = FontWeight.Bold)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.onErrorContainer) }
            niceDateTime(whenIso).takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = c.onErrorContainer)
            }
            Comment(commentLabel.uppercase(), comment, empty = "No comment was left.")
        }
    }
}

/** Photo (tap for a big preview), plant name and a status chip: the top of every card. */
@Composable
private fun CardHeader(
    imageUrl: String?, plantName: String?, scientificName: String?,
    status: String, unread: Boolean = false,
    resolveUrl: (String?) -> String?, onPreview: (String, String) -> Unit
) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        PhotoPreviewThumb(resolveUrl(imageUrl), plantName ?: "Plant", onPreview, size = 56.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(plantLine(plantName, scientificName), style = MaterialTheme.typography.titleSmall, color = c.onSurface)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusChip(status)
                if (unread) Text("NEW", style = MaterialTheme.typography.labelLarge, color = c.primary, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
internal fun PendingApprovalSection(
    state: ApprovalsUiState,
    onAnswer: (requestId: String, approve: Boolean, note: String?) -> Unit,
    onOpenPlant: (String) -> Unit,
    onDismissMessage: () -> Unit,
    resolveUrl: (String?) -> String? = { it },
    onPreview: (url: String, name: String) -> Unit = { _, _ -> }
) {
    val c = MaterialTheme.colorScheme
    val data = state.data

    // Top: what needs MY answer. Then what is still open. Last: what is already approved or denied.
    val needMe = data.awaitingMe.filter { it.needsAnswer }
    val everythingElse: List<Entry> =
        data.awaitingMe.filter { !it.needsAnswer }.map { Entry.Incoming(it) } + data.mine.map { Entry.Mine(it) }
    val stillOpen = everythingElse.filter { it.requestStatus == "pending" }.sortedByDescending { it.sortKey }
    val settled = everythingElse.filter { it.requestStatus != "pending" }.sortedByDescending { it.sortKey }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        state.message?.let { m ->
            Card(colors = CardDefaults.cardColors(containerColor = if (m.isError) c.errorContainer else c.secondaryContainer)) {
                Row(Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(m.text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    PlantTextButton(onDismissMessage) { Text("Dismiss") }
                }
            }
        }
        if (state.loading && !state.loaded) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
        if (state.loaded && needMe.isEmpty() && everythingElse.isEmpty()) {
            Text(
                "Nothing is waiting for approval. When you ask to change someone else's description or a plant's info, " +
                        "or someone asks to change yours, it shows up here.",
                style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
            )
        }

        // ------------------------------------------------------------ waiting for MY answer
        if (needMe.isNotEmpty()) {
            SectionTitle("Waiting for your approval (${needMe.size})")
            Text(
                "Someone asked to change a description you wrote, or the info of a plant you are the primary contributor of. " +
                        "It also needs an admin. If you decline, it is cancelled.",
                style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
            )
            needMe.forEach { a ->
                var note by remember(a.requestId) { mutableStateOf("") }
                val busy = state.answeringId == a.requestId
                PlantSurface(Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        CardHeader(a.imageUrl, a.plantName, a.scientificName, "pending", false, resolveUrl, onPreview)
                        Text(
                            "${a.requesterName ?: "Someone"} ${askedWhat(a)}" +
                                    (niceDateTime(a.createdAt).takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                            style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
                        )
                        a.reason?.takeIf { it.isNotBlank() }?.let { Comment("REASON GIVEN BY ${(a.requesterName ?: "THE REQUESTER").uppercase()}", it) }
                        ChangeDiff(a.changes)
                        OutlinedTextField(
                            value = note, onValueChange = { note = it },
                            label = { Text("Note to ${a.requesterName ?: "them"} (optional)") },
                            modifier = Modifier.fillMaxWidth(), minLines = 1, maxLines = 3,
                            keyboardOptions = KeyboardOptions.Default, shape = MaterialTheme.shapes.small
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            PlantButton({ onAnswer(a.requestId, true, note) }, enabled = state.answeringId == null) {
                                Text(if (busy) "Saving…" else "Approve")
                            }
                            PlantOutlinedButton({ onAnswer(a.requestId, false, note) }, enabled = state.answeringId == null) {
                                Text("Decline")
                            }
                            a.plantId?.let { id -> PlantTextButton({ onOpenPlant(id) }) { Text("See plant") } }
                        }
                    }
                }
            }
        }

        // ------------------------------------------------------------ not decided yet
        if (stillOpen.isNotEmpty()) {
            SectionTitle("Still open (${stillOpen.size})")
            stillOpen.forEach { e -> EntryCard(e, onOpenPlant, resolveUrl, onPreview) }
        }

        // ------------------------------------------------------------ approved or denied: the bottom
        if (settled.isNotEmpty()) {
            SectionTitle("Approved or denied (${settled.size})")
            Text(
                "Newest first. A denied request is deleted automatically 30 days after it was decided.",
                style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
            )
            settled.forEach { e -> EntryCard(e, onOpenPlant, resolveUrl, onPreview) }
        }
    }
}

@Composable
private fun EntryCard(e: Entry, onOpenPlant: (String) -> Unit, resolveUrl: (String?) -> String?, onPreview: (String, String) -> Unit) {
    when (e) {
        is Entry.Mine -> MineCard(e.m, onOpenPlant, resolveUrl, onPreview)
        is Entry.Incoming -> IncomingCard(e.a, onOpenPlant, resolveUrl, onPreview)
    }
}

/** A change somebody asked of ME that I already answered (or that was settled before I did). */
@Composable
private fun IncomingCard(a: AwaitingApprovalDto, onOpenPlant: (String) -> Unit, resolveUrl: (String?) -> String?, onPreview: (String, String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val requester = a.requesterName ?: "Someone"
    PlantSurface(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            CardHeader(a.imageUrl, a.plantName, a.scientificName, a.status, false, resolveUrl, onPreview)
            Text(
                "$requester ${askedWhat(a)}" + (niceDateTime(a.createdAt).takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
            )

            // A decline starts the card: who declined it and what they wrote.
            when {
                a.ownerStatus == "denied" -> DeclinedBanner(
                    title = "You declined this change",
                    detail = if (a.scope == "base") "You are the primary contributor of this plant." else "It was a change to your description.",
                    whenIso = a.ownerDecidedAt ?: a.reviewedAt,
                    comment = a.ownerNote,
                    commentLabel = "Your comment"
                )
                a.status == "denied" -> DeclinedBanner(
                    title = "Declined by an admin",
                    detail = "You approved it, but an admin declined it. Nothing was changed.",
                    whenIso = a.reviewedAt, comment = null, commentLabel = "The admin's comment"
                )
                a.status == "approved" -> Text(
                    "Approved. The change is now on the plant.",
                    style = MaterialTheme.typography.labelLarge, color = c.primary
                )
            }

            AnswerRow("You", null, a.ownerStatus, a.ownerDecidedAt, a.ownerNote, "You left no comment.")
            // A decline by me ends the request; the admin never sees it.
            if (a.ownerStatus != "denied") AnswerRow("Admin", null, a.status, a.reviewedAt, null)

            a.reason?.takeIf { it.isNotBlank() }?.let { Comment("REASON GIVEN BY ${requester.uppercase()}", it) }
            ChangeDiff(a.changes)
            a.plantId?.let { id -> PlantTextButton({ onOpenPlant(id) }) { Text("See plant") } }
        }
    }
}

/** A change I asked for, open or decided. */
@Composable
private fun MineCard(m: MyApprovalDto, onOpenPlant: (String) -> Unit, resolveUrl: (String?) -> String?, onPreview: (String, String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val owner = m.owner
    val ownerStatus = owner?.status ?: "pending"
    val who = ownerLabel(owner?.role)
    val declinedByOwner = owner != null && ownerStatus == "denied"
    val declinedByAdmin = m.status == "denied" && !declinedByOwner
    // The admin's own comment; the "[contributor declined] ..." text the server stores for a decline is not one.
    val adminNote = m.note?.takeIf { m.status != "pending" && !it.startsWith("[") && it.isNotBlank() }
    val adminStatus = when {
        m.status == "pending" && owner != null && ownerStatus != "approved" -> "blocked"
        else -> m.status
    }

    PlantSurface(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            CardHeader(m.imageUrl, m.plantName, m.scientificName, m.status, m.unread, resolveUrl, onPreview)

            // What this change is about and whose words it touches.
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(scopeTitle(m), style = MaterialTheme.typography.bodyMedium, color = c.onSurface, fontWeight = FontWeight.SemiBold)
                if (owner != null) {
                    Text(
                        if (owner.role == "primary") "Primary contributor of this plant: ${owner.name ?: "—"}"
                        else "Description written by ${owner.name ?: "—"}",
                        style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
                    )
                }
                Text(
                    "Asked ${niceDateTime(m.createdAt)}",
                    style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
                )
            }

            // A decline starts the card: who declined it, when, and what they wrote.
            when {
                declinedByOwner -> DeclinedBanner(
                    title = "Declined by ${owner?.name ?: "the ${who.lowercase()}"}",
                    detail = if (owner?.role == "primary") "$who of this plant. Nothing was changed."
                    else "You were changing ${owner?.name ?: "their"}'s description. Nothing was changed.",
                    whenIso = owner?.decidedAt ?: m.reviewedAt,
                    comment = owner?.note,
                    commentLabel = "${owner?.name ?: who}'s comment"
                )
                declinedByAdmin -> DeclinedBanner(
                    title = "Declined by an admin",
                    detail = "Nothing was changed." +
                            if (owner != null && ownerStatus == "approved") " ${owner.name ?: who} had approved it." else "",
                    whenIso = m.reviewedAt,
                    comment = adminNote,
                    commentLabel = "The admin's comment"
                )
                m.status == "approved" -> Text(
                    "Approved. The change is now on the plant.",
                    style = MaterialTheme.typography.labelLarge, color = c.primary
                )
            }

            // The contributor first (when there is one), then the admin.
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                owner?.let { o ->
                    AnswerRow(who, o.name, ownerStatus, o.decidedAt, o.note, "No comment was left.")
                }
                // A decline by the contributor ends the request; the admin never sees it.
                if (!declinedByOwner) {
                    AnswerRow("Admin", null, adminStatus, m.reviewedAt, adminNote, "No comment was left.")
                }
            }

            m.reason?.takeIf { it.isNotBlank() }?.let { Comment("YOUR REASON", it) }
            ChangeDiff(m.changes)
            m.plantId?.let { id -> PlantTextButton({ onOpenPlant(id) }) { Text("See plant") } }
        }
    }
}
