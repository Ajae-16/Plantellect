package com.plantellect.mobileplantellect.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp

/**
 * The color themes of Settings > Appearance. Each one has a light and a dark version, so it works with every
 * Light / Dark / System choice. [PLANTELLECT] is the original green and uses the hand-made palette in Color.kt;
 * the others are built from one hue ([hue], 0..360) so a new theme is one line here.
 *
 * Only the brand colors change. Toxicity chips, scan feedback and the per-contributor colors keep their meaning.
 */
enum class ColorTheme(val title: String, val blurb: String, val hue: Float?) {
    PLANTELLECT("Default", "The original fresh greens.", null),
    OCEAN("Ocean", "Cool, clear blues.", 205f),
    TEAL("Lagoon", "Calm blue-green.", 175f),
    LAVENDER("Lavender", "Soft purples.", 265f),
    ROSE("Rose", "Warm garden pinks.", 340f),
    SUNSET("Sunset", "Amber and orange warmth.", 24f);

    companion object {
        /** An unknown or removed name gives the original theme. */
        fun fromName(name: String?): ColorTheme = entries.firstOrNull { it.name == name } ?: PLANTELLECT
    }
}

private fun hsl(h: Float, s: Float, l: Float) = Color.hsl(((h % 360f) + 360f) % 360f, s.coerceIn(0f, 1f), l.coerceIn(0f, 1f))

/** The Material colors of a hue-based theme. The original green is not built here (see Theme.kt). */
internal fun generatedScheme(h: Float, dark: Boolean): ColorScheme =
    if (!dark) lightColorScheme(
        primary = hsl(h, .55f, .32f), onPrimary = Color.White,
        secondary = hsl(h, .22f, .36f), onSecondary = Color.White,
        tertiary = hsl(h + 150f, .50f, .85f), onTertiary = hsl(h + 150f, .50f, .18f),
        background = hsl(h, .45f, .96f), onBackground = hsl(h, .35f, .10f),
        surface = Color.White, onSurface = hsl(h, .35f, .10f),
        surfaceVariant = hsl(h, .30f, .89f), onSurfaceVariant = hsl(h, .15f, .27f),
        surfaceContainerLowest = Color.White,
        surfaceContainerLow = hsl(h, .35f, .95f),
        surfaceContainer = hsl(h, .35f, .92f),
        surfaceContainerHigh = hsl(h, .30f, .90f),
        surfaceContainerHighest = hsl(h, .30f, .87f),
        primaryContainer = hsl(h, .55f, .85f), onPrimaryContainer = hsl(h, .35f, .10f),
        secondaryContainer = hsl(h, .40f, .90f),
        tertiaryContainer = Color.White,
        outline = hsl(h, .10f, .45f), outlineVariant = hsl(h, .20f, .80f),
        error = ErrorLight, onError = Color.White,
        errorContainer = ErrorContainerLight, onErrorContainer = Color(0xFF410002)
    ) else darkColorScheme(
        primary = hsl(h, .60f, .65f), onPrimary = hsl(h, .55f, .14f),
        secondary = hsl(h, .25f, .75f), onSecondary = hsl(h, .40f, .12f),
        tertiary = hsl(h + 150f, .30f, .40f), onTertiary = Color.White,
        background = hsl(h, .40f, .06f), onBackground = hsl(h, .30f, .89f),
        surface = hsl(h, .35f, .09f), onSurface = hsl(h, .30f, .89f),
        surfaceVariant = hsl(h, .30f, .17f), onSurfaceVariant = hsl(h, .18f, .75f),
        surfaceContainerLowest = hsl(h, .40f, .04f),
        surfaceContainerLow = hsl(h, .38f, .07f),
        surfaceContainer = hsl(h, .35f, .09f),
        surfaceContainerHigh = hsl(h, .30f, .13f),
        surfaceContainerHighest = hsl(h, .30f, .17f),
        primaryContainer = hsl(h, .45f, .20f), onPrimaryContainer = hsl(h, .30f, .89f),
        secondaryContainer = hsl(h, .40f, .12f),
        tertiaryContainer = hsl(h, .40f, .05f),
        outline = hsl(h, .12f, .55f), outlineVariant = hsl(h, .20f, .25f),
        error = ErrorDark, onError = Color(0xFF690005),
        errorContainer = ErrorContainerDark, onErrorContainer = Color(0xFFFFDAD6)
    )

/**
 * The brand-tinted extras of a hue-based theme: card borders, type chips, the soft photo backdrop, the card's accent
 * bar, and the two marks used in descriptions.
 *  - ==highlight==  always YELLOW, nudged toward the theme hue so it belongs to the theme (a warmer or cooler yellow).
 *  - !!important!!  always RED and bold, nudged the same way (a pinker or oranger red).
 * The nudge is small on purpose: yellow still reads as a highlighter and red as a warning in every theme. Both stay
 * light with dark letters in dark mode too.
 */
internal fun generatedExtras(base: ExtraColors, h: Float, dark: Boolean): ExtraColors {
    val b = base
    return b.withBrand(
        forest = if (!dark) hsl(h, .55f, .25f) else hsl(h, .60f, .65f),
        onForestChip = if (!dark) hsl(h, .55f, .18f) else hsl(h, .30f, .89f),
        photoBackdropStart = if (!dark) hsl(h, .45f, .88f) else hsl(h, .45f, .20f),
        photoBackdropEnd = if (!dark) hsl(h, .40f, .75f) else hsl(h, .40f, .12f),
        photoAccent = if (!dark) hsl(h, .70f, .78f) else hsl(h, .70f, .72f),
        highlightBg = lerp(b.highlightBg, hsl(h, .90f, .80f), .22f),
        highlightFg = lerp(b.highlightFg, hsl(h, .85f, .12f), .30f),
        importantBg = lerp(b.importantBg, hsl(h, .90f, .86f), .14f),
        importantFg = lerp(b.importantFg, hsl(h, .80f, .20f), .12f),
        importantOnHighlight = b.importantOnHighlight
    )
}
