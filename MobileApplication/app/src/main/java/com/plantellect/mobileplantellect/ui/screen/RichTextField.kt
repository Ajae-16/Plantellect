package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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
 * A text box for a contributor's description with a formatting toolbar. Select words and tap a
 * button and they change right there: bold looks bold, a highlight looks highlighted. Nothing
 * technical shows. Tap a button with nothing selected to format what you type next.
 *
 * [value] and [onValueChange] carry the server's text (the one RichTextView reads), so this drops
 * in wherever a plain text box was. The text is only rewritten when the person edits it.
 */
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
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
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
            modifier = Modifier.fillMaxWidth(),
            label = { Text(label) },
            isError = isError,
            supportingText = supportingText?.let { { Text(it) } },
            minLines = minLines,
            visualTransformation = transformation,
            shape = MaterialTheme.shapes.small
        )
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
