package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.plantellect.mobileplantellect.data.logic.RichBlock
import com.plantellect.mobileplantellect.data.logic.RichLine
import com.plantellect.mobileplantellect.data.logic.RichMark
import com.plantellect.mobileplantellect.data.logic.RichText
import com.plantellect.mobileplantellect.ui.theme.ExtraColors
import com.plantellect.mobileplantellect.ui.theme.extraColors

/**
 * A contributor's description with the website's formatting: paragraphs, bullets, numbered steps,
 * bold, italic, underline, strike, ==highlight== and !!important!!. Parsing is in data/logic/RichText.kt;
 * the highlight and important colors are in ui/theme/ExtraColors.kt (they follow dark mode).
 *
 * [emptyText] is shown, dimmed, when [text] has nothing in it; null shows nothing.
 */
@Composable
fun RichTextView(
    text: String?,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    color: Color = MaterialTheme.colorScheme.onSurface,
    emptyText: String? = null
) {
    val blocks = remember(text) { RichText.parse(text) }
    val extra = MaterialTheme.extraColors
    if (blocks.isEmpty()) {
        if (emptyText != null) Text(emptyText, modifier, style = style, color = color.copy(alpha = 0.65f), fontStyle = FontStyle.Italic)
        return
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { block ->
            when (block) {
                is RichBlock.Paragraph -> Text(annotate(block.lines, extra), style = style, color = color)
                is RichBlock.Bullets -> block.items.forEach { item -> ListRow("•", item, extra, style, color) }
                is RichBlock.Numbered -> block.items.forEachIndexed { n, item -> ListRow("${n + 1}.", item, extra, style, color) }
            }
        }
    }
}

@Composable
private fun ListRow(marker: String, item: RichLine, extra: ExtraColors, style: TextStyle, color: Color) {
    Row(Modifier.padding(start = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(marker, Modifier.widthIn(min = 16.dp), style = style, color = color)
        Text(annotate(listOf(item), extra), style = style, color = color)
    }
}

/** Lines joined with a line break, each mark turned into a span. */
private fun annotate(lines: List<RichLine>, extra: ExtraColors): AnnotatedString = buildAnnotatedString {
    lines.forEachIndexed { index, line ->
        if (index > 0) append('\n')
        val offset = length
        append(line.text)
        line.spans.forEach { span -> addStyle(richSpanStyle(span.mark, extra), offset + span.start, offset + span.end) }
    }
}

/** How one mark looks. Shared by the reader (RichTextView) and the editor (RichTextField). */
internal fun richSpanStyle(mark: RichMark, extra: ExtraColors): SpanStyle = when (mark) {
    RichMark.BOLD -> SpanStyle(fontWeight = FontWeight.Bold)
    RichMark.ITALIC -> SpanStyle(fontStyle = FontStyle.Italic)
    RichMark.UNDERLINE -> SpanStyle(textDecoration = TextDecoration.Underline)
    RichMark.STRIKE -> SpanStyle(textDecoration = TextDecoration.LineThrough)
    RichMark.HIGHLIGHT -> SpanStyle(background = extra.highlightBg, color = extra.highlightFg)
    RichMark.IMPORTANT -> SpanStyle(background = extra.importantBg, color = extra.importantFg, fontWeight = FontWeight.Bold)
}
