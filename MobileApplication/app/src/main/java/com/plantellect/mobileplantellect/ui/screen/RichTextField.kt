package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ContentCut
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.SelectAll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.plantellect.mobileplantellect.data.logic.RichDoc
import com.plantellect.mobileplantellect.data.logic.RichEditing
import com.plantellect.mobileplantellect.data.logic.RichMark
import com.plantellect.mobileplantellect.ui.theme.extraColors

/**
 * Stands in for the phone's floating Cut / Copy / Paste bubble. That bubble opens right above the selected
 * words, which is exactly where this field's formatting buttons are, so it hid them. Instead of drawing
 * anything itself, this only remembers which actions the text field offered; [RichTextField] shows them as
 * small buttons at the end of its own toolbar row, where nothing is covered.
 */
/**
 * Holds the formatting buttons of whichever description box is being typed in, so the screen can draw them in
 * one fixed bar just above the keyboard.
 */
@Stable
class RichToolbarHost {
    var content by mutableStateOf<(@Composable () -> Unit)?>(null)
        private set
    private var owner: Any? = null
    fun show(o: Any, c: @Composable () -> Unit) { owner = o; content = c }
    fun hide(o: Any) { if (owner === o) { owner = null; content = null } }
}

val LocalRichToolbarHost = androidx.compose.runtime.compositionLocalOf<RichToolbarHost?> { null }

/** The pinned bar itself: draws the buttons of the focused description box, or nothing. */
@Composable
fun RichToolbarBar(host: RichToolbarHost, modifier: Modifier = Modifier) {
    val content = host.content ?: return
    Surface(
        modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceContainer,
        tonalElevation = 3.dp,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 4.dp)) { content() }
    }
}

/** The most characters a description box accepts. */
const val MAX_CHARS = 5000

@Stable
private class InlineTextToolbar : TextToolbar {
    var onCut by mutableStateOf<(() -> Unit)?>(null)
        private set
    var onCopy by mutableStateOf<(() -> Unit)?>(null)
        private set
    var onPaste by mutableStateOf<(() -> Unit)?>(null)
        private set
    var onSelectAll by mutableStateOf<(() -> Unit)?>(null)
        private set

    override var status: TextToolbarStatus by mutableStateOf(TextToolbarStatus.Hidden)

    override fun showMenu(
        rect: Rect,
        onCopyRequested: (() -> Unit)?,
        onPasteRequested: (() -> Unit)?,
        onCutRequested: (() -> Unit)?,
        onSelectAllRequested: (() -> Unit)?
    ) {
        onCopy = onCopyRequested
        onPaste = onPasteRequested
        onCut = onCutRequested
        onSelectAll = onSelectAllRequested
        status = TextToolbarStatus.Shown
    }

    override fun hide() {
        onCopy = null; onPaste = null; onCut = null; onSelectAll = null
        status = TextToolbarStatus.Hidden
    }
}

/**
 * A text box for a contributor's description with a formatting toolbar. Select words and tap a
 * button and they change right there: bold looks bold, a highlight looks highlighted. Nothing
 * technical shows. Tap a button with nothing selected to format what you type next.
 *
 * [value] and [onValueChange] carry the server's text (the one RichTextView reads), so this drops
 * in wherever a plain text box was. The text is only rewritten when the person edits it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RichTextField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    minLines: Int = 3,
    isError: Boolean = false,
    supportingText: String? = null,
    /** "The same error again": when it changes while [isError] is still true, the box shakes again. */
    errorTrigger: Any? = null
) {
    // Typing or pasting past MAX_CHARS, or an error on the box, shakes it and buzzes (Settings > Touch feedback).
    val shake = rememberShakeState()
    val haptics = rememberHaptics()
    LaunchedEffect(isError, errorTrigger) {
        if (isError) { shake.shake(); haptics.reject() }
    }
    var doc by remember { mutableStateOf(RichEditing.fromMarked(value)) }
    var lastEmitted by remember { mutableStateOf(value) }
    var selection by remember { mutableStateOf(TextRange(doc.text.length)) }
    var composition by remember { mutableStateOf<TextRange?>(null) }
    var typing by remember { mutableStateOf<Set<RichMark>?>(null) }

    // The form changed the text itself (reset, "use my earlier notes"): show it.
    LaunchedEffect(value) {
        if (value != lastEmitted) {
            doc = RichEditing.fromMarked(value)
            lastEmitted = value
            selection = TextRange(doc.text.length)
            typing = null
        }
    }

    fun emit() {
        val marked = RichEditing.toMarked(doc)
        lastEmitted = marked
        onValueChange(marked)
    }

    val clipboard = remember { InlineTextToolbar() }
    val extra = MaterialTheme.extraColors
    val transformation = remember(doc, extra) {
        object : VisualTransformation {
            override fun filter(text: AnnotatedString): TransformedText {
                val styled = buildAnnotatedString {
                    append(text.text)
                    addRichSpans(doc.spans, 0, extra, maxEnd = text.text.length)
                }
                return TransformedText(styled, OffsetMapping.Identity)
            }
        }
    }

    val start = selection.min.coerceIn(0, doc.text.length)
    val end = selection.max.coerceIn(0, doc.text.length)
    val active = RichEditing.marksAt(doc, start, end, typing)

    fun toggle(mark: RichMark) {
        if (start == end) {
            typing = if (mark in active) active - mark else active + mark
        } else {
            doc = RichEditing.toggle(doc, start, end, mark)
            emit()
        }
    }

    fun toggleList(numbered: Boolean) {
        val result = RichEditing.toggleList(doc, start, end, numbered)
        doc = result.doc
        selection = TextRange(result.selStart, result.selEnd)
        typing = null
        emit()
    }

    val host = LocalRichToolbarHost.current
    var showGuide by remember { mutableStateOf(false) }
    if (showGuide) FormattingGuideDialog { showGuide = false }
    var focused by remember { mutableStateOf(false) }
    val owner = remember { Any() }
    // Every letter typed (or caret move) keeps the box on screen. The box itself stops growing after a few
    // lines and scrolls inside, always following the caret, so the newest letter is never hidden.
    val bringIntoView = remember { BringIntoViewRequester() }
    LaunchedEffect(doc.text, selection, focused) { if (focused) bringIntoView.bringIntoView() }
    // The formatting buttons wrap onto as many lines as the screen needs, so none are cut off or hidden
    // behind a sideways scroll on a narrow phone.
    val bar: @Composable () -> Unit = {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // Tools come in groups that wrap as whole units, so the bar fits any screen width or font size.
        // ONE slim line: the tools slide sideways, the counter stays put on the right. A tall wrapping bar
        // would cover the box being typed in.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          // Same sideways row as "Add existing" / "New plant": an arrow shows on the edge that has more tools.
          HScroll(Modifier.weight(1f), spacing = 6.dp) {
            ToolGroup {
                ToolCell("B", "Bold", RichMark.BOLD in active, SpanStyle(fontWeight = FontWeight.Bold)) { toggle(RichMark.BOLD) }
                ToolDivider()
                ToolCell("I", "Italic", RichMark.ITALIC in active, SpanStyle(fontStyle = FontStyle.Italic)) { toggle(RichMark.ITALIC) }
                ToolDivider()
                ToolCell("U", "Underline", RichMark.UNDERLINE in active, SpanStyle(textDecoration = TextDecoration.Underline)) { toggle(RichMark.UNDERLINE) }
            }
            ToolGroup {
                ToolCell("Highlight", "Highlight", RichMark.HIGHLIGHT in active, SpanStyle(), extra.highlightBg to extra.highlightFg) { toggle(RichMark.HIGHLIGHT) }
                ToolDivider()
                ToolCell("Important", "Important", RichMark.IMPORTANT in active, SpanStyle(), extra.importantBg to extra.importantFg) { toggle(RichMark.IMPORTANT) }
            }
            ToolGroup {
                ToolCell("•", "Bullet list", false, SpanStyle(fontWeight = FontWeight.Bold)) { toggleList(numbered = false) }
                ToolDivider()
                ToolCell("1.", "Numbered list", false, SpanStyle(fontWeight = FontWeight.Bold)) { toggleList(numbered = true) }
            }
            ToolGroup {
                ToolCell("Guide", "Formatting guide", false, SpanStyle(fontWeight = FontWeight.Bold)) { showGuide = true }
            }
          }
          // Character counter: always visible while typing.
          Text(
              "${doc.text.length}/$MAX_CHARS",
              Modifier.padding(start = 8.dp),
              style = MaterialTheme.typography.labelMedium, maxLines = 1,
              color = if (doc.text.length >= MAX_CHARS) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
          )
        }
            // Cut / Copy / Paste / Select all replace the phone's floating bubble (which carries Google's
            // Search / Translate actions and covers the buttons above). They show here, on their own row under
            // the formatting buttons, only while the field offers them.
            if (clipboard.status == TextToolbarStatus.Shown) {
                FlowRow(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    clipboard.onCut?.let { ClipButton(Icons.Filled.ContentCut, "Cut", it) }
                    clipboard.onCopy?.let { ClipButton(Icons.Filled.ContentCopy, "Copy", it) }
                    clipboard.onPaste?.let { ClipButton(Icons.Filled.ContentPaste, "Paste", it) }
                    clipboard.onSelectAll?.let { ClipButton(Icons.Filled.SelectAll, "Select all", it) }
                }
            }
        }
    }
    // While typing, hand the buttons to the pinned bar so they stay just above the keyboard.
    if (host != null && focused) SideEffect { host.show(owner, bar) }
    DisposableEffect(host, focused) { onDispose { host?.hide(owner) } }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        CompositionLocalProvider(LocalTextToolbar provides clipboard) {
        OutlinedTextField(
            value = TextFieldValue(doc.text, selection, composition),
            onValueChange = { raw ->
                // At most MAX_CHARS characters: extra typed or pasted text is cut off (and the box shakes).
                if (raw.text.length > MAX_CHARS) { shake.shake(); haptics.reject() }
                val v = if (raw.text.length > MAX_CHARS) raw.copy(
                    text = raw.text.take(MAX_CHARS),
                    selection = TextRange(raw.selection.start.coerceAtMost(MAX_CHARS), raw.selection.end.coerceAtMost(MAX_CHARS)),
                    composition = null
                ) else raw
                composition = v.composition
                if (v.text == doc.text) {
                    if (v.selection != selection) {
                        selection = v.selection
                        typing = null            // the caret moved: the next letters follow the text around it
                    }
                } else {
                    val result = RichEditing.onTextChanged(doc, v.text, v.selection.end, typing)
                    doc = result.doc
                    selection = TextRange(result.selStart, result.selEnd)
                    typing = null
                    emit()
                }
            },
            modifier = Modifier.fillMaxWidth().bringIntoViewRequester(bringIntoView)
                .onFocusChanged { focused = it.isFocused; if (!it.isFocused) clipboard.hide() }
                .shake(shake),
            label = { Text(label) },
            isError = isError,
            supportingText = {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(supportingText.orEmpty(), Modifier.weight(1f))
                    Text(
                        "${doc.text.length} / $MAX_CHARS",
                        color = if (doc.text.length >= MAX_CHARS) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            },
            minLines = minLines,
            maxLines = maxOf(minLines, 5),
            visualTransformation = transformation,
            shape = MaterialTheme.shapes.small
        )
        }

        // Where the screen provides a pinned bar (above the keyboard), the formatting tools live there while
        // this box has focus. Without one, they sit directly under the box.
        if (host == null) bar()

        // A short guide, always under the box and the buttons.
        Text(
            "Select words, then tap a button to format them. With nothing selected, a button formats what you type next.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/** One clipboard action as a small labelled chip, so it reads clearly and wraps with the others. */
@Composable
private fun ClipButton(icon: androidx.compose.ui.graphics.vector.ImageVector, description: String, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = hapticClick(onClick),
        shape = MaterialTheme.shapes.small,
        color = colors.secondaryContainer,
        border = BorderStroke(1.dp, colors.outlineVariant)
    ) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp), tint = colors.onSecondaryContainer)
            Text(
                description, Modifier.padding(start = 6.dp),
                style = MaterialTheme.typography.labelMedium, color = colors.onSecondaryContainer
            )
        }
    }
}

private fun buildAnnotatedStringWith(label: String, style: SpanStyle) = buildAnnotatedString {
    pushStyle(style)
    append(label)
    pop()
}

/** What each formatting button does, in plain words. */
@Composable
private fun FormattingGuideDialog(onClose: () -> Unit) {
    val extra = MaterialTheme.extraColors
    @Composable
    fun GuideRow(label: String, style: SpanStyle, text: String, chip: Pair<Color, Color>? = null) {
        androidx.compose.foundation.layout.Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(0.4f).padding(end = 12.dp), contentAlignment = Alignment.CenterStart) {
                if (chip != null) MarkChip(label, chip.first, chip.second, bold = label == "Important")
                else Text(buildAnnotatedStringWith(label, style))
            }
            Text(text, Modifier.weight(0.6f), style = MaterialTheme.typography.bodyMedium)
        }
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Formatting guide") },
        text = {
            Column(Modifier.verticalScroll(androidx.compose.foundation.rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Select the words you want to change, then tap a button. Tap it again to undo. " +
                            "With nothing selected, a button formats what you type next.",
                    style = MaterialTheme.typography.bodyMedium
                )
                GuideRow("B  Bold", SpanStyle(fontWeight = FontWeight.Bold), "Thicker letters. Use it for names and key words.")
                GuideRow("I  Italic", SpanStyle(fontStyle = FontStyle.Italic), "Slanted letters. Good for scientific names.")
                GuideRow("U  Underline", SpanStyle(textDecoration = TextDecoration.Underline), "Draws a line under the words.")
                GuideRow("Highlight", SpanStyle(), "Marks the words like a highlighter pen, so readers notice them. It takes the app's color theme.", extra.highlightBg to extra.highlightFg)
                GuideRow("Important", SpanStyle(), "Always red and bold. Use it for warnings and safety notes. On highlighted words it keeps the highlight color and only turns the letters red.", extra.importantBg to extra.importantFg)
                GuideRow("•  List", SpanStyle(), "Turns the selected lines into a bullet list. Tap again to turn it off.")
                GuideRow("1.  List", SpanStyle(), "Turns the selected lines into a numbered list.")
                Text("Each box holds up to $MAX_CHARS characters.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = { PlantTextButton(onClose) { Text("Got it") } }
    )
}

/** A rounded frame around a few related tools, so the bar reads as groups instead of one long strip of buttons. */
@Composable
private fun ToolGroup(content: @Composable RowScope.() -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(
        shape = MaterialTheme.shapes.small,
        color = colors.surface,
        border = BorderStroke(1.dp, colors.outlineVariant)
    ) {
        Row(Modifier.height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, content = content)
    }
}

@Composable
private fun ToolDivider() {
    Box(Modifier.width(1.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outlineVariant))
}

/**
 * One tool inside a group, drawn in the style it applies. It is at least 44 dp square (a comfortable tap) and
 * grows with the phone's font size instead of cutting the label off.
 */
@Composable
private fun ToolCell(
    label: String, description: String, active: Boolean, style: SpanStyle,
    /** (background, text) of a mark that is shown as a small rounded chip, like Highlight and Important. */
    chip: Pair<Color, Color>? = null,
    onClick: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    Box(
        Modifier
            .defaultMinSize(minWidth = 44.dp, minHeight = 44.dp)
            .background(if (active) colors.primaryContainer else Color.Transparent)
            .hapticClickable(onClickLabel = description, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = if (active) "$description, on" else description }
            .padding(horizontal = 10.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center
    ) {
        if (chip != null) MarkChip(label, chip.first, chip.second, bold = label == "Important")
        else Text(
            buildAnnotatedStringWith(label, style),
            style = MaterialTheme.typography.labelLarge,
            color = if (active) colors.onPrimaryContainer else colors.onSurface,
            maxLines = 1
        )
    }
}

/** The look of Highlight / Important as a small rounded chip (the text itself can only be a square wash). */
@Composable
private fun MarkChip(text: String, bg: Color, fg: Color, bold: Boolean) {
    // A soft gradient: the mark's own color, drifting a little toward the theme's container color.
    val end = androidx.compose.ui.graphics.lerp(bg, MaterialTheme.colorScheme.primaryContainer, 0.28f)
    Surface(shape = androidx.compose.foundation.shape.RoundedCornerShape(7.dp), color = Color.Transparent, contentColor = fg) {
        Text(
            text,
            Modifier.background(androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(bg, end)))
                .padding(horizontal = 9.dp, vertical = 3.dp),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium, maxLines = 1
        )
    }
}
