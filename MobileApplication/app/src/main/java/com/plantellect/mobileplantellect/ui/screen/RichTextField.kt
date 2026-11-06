package com.plantellect.mobileplantellect.ui.screen

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
    supportingText: String? = null
) {
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
                    doc.spans.forEach { span ->
                        val end = span.end.coerceAtMost(text.text.length)
                        if (span.start < end) addStyle(richSpanStyle(span.mark, extra), span.start, end)
                    }
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

    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // The formatting buttons wrap onto as many lines as the screen needs, so none are cut off or hidden
        // behind a sideways scroll on a narrow phone.
        FlowRow(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            ToolButton("B", RichMark.BOLD in active, SpanStyle(fontWeight = FontWeight.Bold)) { toggle(RichMark.BOLD) }
            ToolButton("I", RichMark.ITALIC in active, SpanStyle(fontStyle = FontStyle.Italic)) { toggle(RichMark.ITALIC) }
            ToolButton("U", RichMark.UNDERLINE in active, SpanStyle(textDecoration = TextDecoration.Underline)) { toggle(RichMark.UNDERLINE) }
            ToolButton("S", RichMark.STRIKE in active, SpanStyle(textDecoration = TextDecoration.LineThrough)) { toggle(RichMark.STRIKE) }
            ToolButton("Highlight", RichMark.HIGHLIGHT in active, richSpanStyle(RichMark.HIGHLIGHT, extra)) { toggle(RichMark.HIGHLIGHT) }
            ToolButton("Important", RichMark.IMPORTANT in active, richSpanStyle(RichMark.IMPORTANT, extra)) { toggle(RichMark.IMPORTANT) }
            ToolButton("•  List", false, SpanStyle()) { toggleList(numbered = false) }
            ToolButton("1.  List", false, SpanStyle()) { toggleList(numbered = true) }
        }
        // Cut / Copy / Paste / Select all replace the phone's floating bubble (which carries Google's
        // Search / Translate actions and covers the buttons above). They show here, on their own row under
        // the formatting buttons, only while the field offers them.
        if (clipboard.status == TextToolbarStatus.Shown) {
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                clipboard.onCut?.let { ClipButton(Icons.Filled.ContentCut, "Cut", it) }
                clipboard.onCopy?.let { ClipButton(Icons.Filled.ContentCopy, "Copy", it) }
                clipboard.onPaste?.let { ClipButton(Icons.Filled.ContentPaste, "Paste", it) }
                clipboard.onSelectAll?.let { ClipButton(Icons.Filled.SelectAll, "Select all", it) }
            }
        }

        CompositionLocalProvider(LocalTextToolbar provides clipboard) {
        OutlinedTextField(
            value = TextFieldValue(doc.text, selection, composition),
            onValueChange = { v ->
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
            modifier = Modifier.fillMaxWidth().onFocusChanged { if (!it.isFocused) clipboard.hide() },
            label = { Text(label) },
            isError = isError,
            supportingText = supportingText?.let { { Text(it) } },
            minLines = minLines,
            visualTransformation = transformation,
            shape = MaterialTheme.shapes.small
        )
        }
    }
}

/** One clipboard action as a small labelled chip, so it reads clearly and wraps with the others. */
@Composable
private fun ClipButton(icon: androidx.compose.ui.graphics.vector.ImageVector, description: String, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.small,
        color = colors.secondaryContainer,
        border = BorderStroke(1.dp, colors.outlineVariant)
    ) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp), tint = colors.onSecondaryContainer)
            Text(
                description, Modifier.padding(start = 6.dp),
                style = MaterialTheme.typography.labelMedium, color = colors.onSecondaryContainer
            )
        }
    }
}

/** One toolbar button, drawn in the style it applies so nobody has to read a code. */
@Composable
private fun ToolButton(label: String, active: Boolean, style: SpanStyle, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.small,
        color = if (active) colors.primaryContainer else colors.surface,
        border = BorderStroke(1.dp, if (active) colors.primary else colors.outlineVariant)
    ) {
        Text(
            buildAnnotatedStringWith(label, style),
            Modifier.padding(PaddingValues(horizontal = 12.dp, vertical = 6.dp)),
            style = MaterialTheme.typography.labelLarge.merge(TextStyle(fontWeight = FontWeight.Medium)),
            color = if (active) colors.onPrimaryContainer else colors.onSurface
        )
    }
}

private fun buildAnnotatedStringWith(label: String, style: SpanStyle) = buildAnnotatedString {
    pushStyle(style)
    append(label)
    pop()
}
