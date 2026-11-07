package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/** Number of characters as the server counts them: an emoji is one, not two. */
internal fun String.charCount(): Int = codePointCount(0, length)

/** The first [max] characters, never cutting an emoji in half. */
internal fun String.takeChars(max: Int): String =
    if (charCount() <= max) this else substring(0, offsetByCodePoints(0, max))

/**
 * A text box with a hard character limit.
 *
 *  - You cannot type past [maxChars]: the extra character is simply not accepted, and a paste that is too
 *    long is cut to fit.
 *  - When that happens an error stays under the box ("You reached the maximum of N characters") until you
 *    delete something.
 *  - The cursor stays at the end of what you typed, and the box scrolls so the newest letter is visible.
 *
 * Pass [maxChars] = Int.MAX_VALUE for "no limit" (then it behaves like a plain OutlinedTextField).
 * [errorText] is another problem to show (for example "required"); the limit message wins over it.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
internal fun LimitedOutlinedTextField(
    value: String,
    onValueChange: (String) -> Unit,
    maxChars: Int,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    errorText: String? = null,
    enabled: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (minLines == 1) 1 else Int.MAX_VALUE,
    singleLine: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    showCounter: Boolean = false,
    focusRequester: FocusRequester? = null,
    shape: androidx.compose.ui.graphics.Shape = MaterialTheme.shapes.small
) {
    var field by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    var atLimit by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    val bring = remember { BringIntoViewRequester() }

    // Something outside changed the text (a reset, a different description loaded): follow it, cursor at the end.
    LaunchedEffect(value) {
        if (field.text != value) field = TextFieldValue(value, TextRange(value.length))
    }
    // Keep the newest letter on screen while typing (inside the box and inside a scrolling page).
    LaunchedEffect(field.text, field.selection, focused) {
        if (focused) runCatching { bring.bringIntoView() }
    }

    val count = field.text.charCount()
    val limitMessage = if (atLimit) "You reached the maximum of $maxChars characters. Extra text was not added." else null
    val shownError = limitMessage ?: errorText

    var fieldModifier = modifier.bringIntoViewRequester(bring).onFocusChanged { focused = it.isFocused }
    if (focusRequester != null) fieldModifier = fieldModifier.focusRequester(focusRequester)

    OutlinedTextField(
        value = field,
        onValueChange = { next ->
            if (next.text.charCount() <= maxChars) {
                field = next
                atLimit = false
                if (next.text != value) onValueChange(next.text)
            } else {
                // Too long. One typed letter: refuse it and keep the cursor where it was. A long paste: keep what fits.
                val grew = next.text.length - field.text.length
                field = if (grew in 1..2) field else {
                    val cut = next.text.takeChars(maxChars)
                    TextFieldValue(cut, TextRange(cut.length))
                }
                atLimit = true
                if (field.text != value) onValueChange(field.text)
            }
        },
        modifier = fieldModifier,
        enabled = enabled,
        label = label?.let { { Text(it) } },
        placeholder = placeholder?.let { { Text(it) } },
        isError = shownError != null,
        supportingText = if (shownError != null || showCounter) {
            {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(shownError ?: "", Modifier.weight(1f, fill = false))
                    if (showCounter) Text("$count/$maxChars")
                }
            }
        } else null,
        minLines = minLines,
        maxLines = maxLines,
        singleLine = singleLine,
        keyboardOptions = keyboardOptions,
        shape = shape
    )
}

/**
 * A small editor that sits directly above the keyboard: title, the text box, and the Save / Cancel buttons
 * underneath it, so the buttons never hide behind the keyboard. Used for the bio; reuse it for any single
 * long text that is edited on its own.
 */
@Composable
internal fun KeyboardEditDialog(
    title: String,
    value: String,
    onValueChange: (String) -> Unit,
    maxChars: Int,
    saveLabel: String,
    saving: Boolean,
    saveEnabled: Boolean,
    onSave: () -> Unit,
    onCancel: () -> Unit,
    placeholder: String? = null,
    errorText: String? = null
) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Dialog(
        onDismissRequest = { if (!saving) onCancel() },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)
    ) {
        Box(Modifier.fillMaxSize()) {
            Surface(
                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().imePadding(),
                shape = MaterialTheme.shapes.large,
                tonalElevation = 6.dp,
                shadowElevation = 8.dp
            ) {
                Column(
                    Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(title, style = MaterialTheme.typography.titleMedium)
                    LimitedOutlinedTextField(
                        value = value,
                        onValueChange = onValueChange,
                        maxChars = maxChars,
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = placeholder,
                        errorText = errorText,
                        enabled = !saving,
                        minLines = 3,
                        maxLines = 6,
                        showCounter = true,
                        focusRequester = focus
                    )
                    if (saving) LinearProgressIndicator(Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        PlantButton(onClick = onSave, enabled = !saving && saveEnabled) {
                            Text(if (saving) "Saving…" else saveLabel)
                        }
                        PlantTextButton(onClick = onCancel, enabled = !saving) { Text("Cancel") }
                    }
                }
            }
        }
    }
}
