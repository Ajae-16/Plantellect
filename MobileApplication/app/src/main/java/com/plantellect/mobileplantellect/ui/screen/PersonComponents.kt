package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * A person's name. With an [accountId] it is underlined and tappable (opens their profile).
 * Without one (the server did not send it) it is plain text, so nothing looks tappable that is not.
 */
@Composable
fun PersonLink(
    name: String,
    accountId: String?,
    color: Color,
    style: TextStyle,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
    fontWeight: FontWeight? = FontWeight.Bold
) {
    if (accountId == null) {
        Text(name, modifier, style = style, color = color, fontWeight = fontWeight)
    } else {
        Text(
            name,
            modifier.clickable(onClickLabel = "Open $name's profile") { onOpen(accountId) },
            style = style, color = color, fontWeight = fontWeight,
            textDecoration = TextDecoration.Underline
        )
    }
}

/** Round profile picture with a ring; the person's initial when there is no photo. Tappable when [onClick] is set. */
@Composable
fun Avatar(
    name: String?,
    photoUrl: String?,
    size: Dp,
    ring: Color,
    fg: Color,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null
) {
    var m = modifier.size(size).clip(CircleShape).border(2.dp, ring, CircleShape).background(ring.copy(alpha = 0.25f))
    if (onClick != null) m = m.clickable(onClickLabel = "Open profile") { onClick() }
    Box(m, contentAlignment = Alignment.Center) {
        if (photoUrl != null) PlantPhoto(photoUrl, name ?: "Profile photo", Modifier.fillMaxSize(), maxPx = 128, placeholder = false)
        else Text(
            name?.trim()?.firstOrNull()?.uppercase() ?: "?",
            style = MaterialTheme.typography.labelLarge, color = fg,
            // The initial shrinks with the circle (a 24 dp avatar beside a name is much smaller than a 32 dp one).
            fontSize = if (size < 30.dp) (size.value * 0.5f).sp else MaterialTheme.typography.labelLarge.fontSize
        )
    }
}