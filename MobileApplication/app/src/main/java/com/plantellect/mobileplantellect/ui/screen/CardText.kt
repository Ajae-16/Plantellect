package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp

/**
 * Text that fits its slot. It starts at [fontSize] and, when the text does not fit in [maxLines]
 * (a long name, a big phone font size, a narrow card), steps the size down towards [minFontSize].
 * Only when it still does not fit at the smallest size is it cut with "...".
 * The line height follows the size, so shrinking never leaves big gaps.
 */
@Composable
fun FitText(
    text: String,
    fontSize: TextUnit,
    modifier: Modifier = Modifier,
    minFontSize: TextUnit = (fontSize.value * 0.7f).sp,
    lineHeightRatio: Float = 1.25f,
    color: Color = Color.Unspecified,
    fontWeight: FontWeight? = null,
    fontStyle: FontStyle? = null,
    letterSpacing: TextUnit = TextUnit.Unspecified,
    style: TextStyle = LocalTextStyle.current,
    minLines: Int = 1,
    maxLines: Int = 1
) {
    var size by remember(text, fontSize, maxLines) { mutableStateOf(fontSize) }
    Text(
        text,
        modifier,
        color = color,
        fontSize = size,
        fontWeight = fontWeight,
        fontStyle = fontStyle,
        letterSpacing = letterSpacing,
        lineHeight = (size.value * lineHeightRatio).sp,
        minLines = minLines,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        style = style,
        onTextLayout = { r ->
            if (r.hasVisualOverflow && size.value > minFontSize.value) {
                size = (size.value * 0.92f).coerceAtLeast(minFontSize.value).sp
            }
        }
    )
}
