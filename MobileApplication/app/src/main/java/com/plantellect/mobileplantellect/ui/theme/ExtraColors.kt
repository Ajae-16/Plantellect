package com.plantellect.mobileplantellect.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Colors the Material scheme has no slot for (chips for toxicity levels, scrims over photos, the
 * type-tinted placeholder art, ...). Screens read them with `MaterialTheme.extraColors`, never with
 * a hard-coded Color(0x...) / Color.White / Color.Black, so dark mode and any later re-theme are an
 * edit in THIS file only.
 *
 * Provided by [MobilePlantellectTheme] from the same dark / light switch as the Material scheme.
 */
@Immutable
class ToxicityPalette(val background: Color, val content: Color, val border: Color) {
    val triple: Triple<Color, Color, Color> get() = Triple(background, content, border)
}

/** One contributor's colors on a plant profile (css/core/variables.css --contrib-N-bg / -accent / -fg). */
@Immutable
class ContributorPalette(val bg: Color, val accent: Color, val fg: Color)

/** The two colors of a plant type's placeholder artwork (home.css --ph-a / --ph-b). */
@Immutable
class PlaceholderTint(val a: Color, val b: Color)

@Immutable
class ExtraColors(
    // ---- over photos and the camera: the same in light and dark, because a photo is not themed ----
    /** Base of every scrim, shade and full-screen photo viewer. Screens set the alpha. */
    val overlay: Color,
    /** Text and icons drawn on [overlay] or straight on a photo. */
    val onOverlay: Color,
    /** Dark base of the gradient behind a card's text on its photo. */
    val photoShade: Color,
    /** Small accent bar under a card's name on its photo. */
    val photoAccent: Color,

    // ---- library cards ------------------------------------------------------------------------
    /** Brand green for card borders, plant-type chips and the card's "good" text. */
    val forest: Color,
    /** Text on a chip tinted with [forest]. */
    val onForestChip: Color,
    /** Soft gradient behind a library card's photo. */
    val photoBackdropStart: Color,
    val photoBackdropEnd: Color,

    // ---- toxicity ------------------------------------------------------------------------------
    /** Chips on the cards. */
    val toxNone: ToxicityPalette,
    val toxMild: ToxicityPalette,
    val toxModerate: ToxicityPalette,
    val toxSevere: ToxicityPalette,
    val toxUnknown: ToxicityPalette,
    /** Solid pills on the plant profile. */
    val pillMild: ToxicityPalette,
    val pillModerate: ToxicityPalette,
    val pillSevere: ToxicityPalette,
    /** A caution fill (mild toxicity badge) and the text on it. */
    val warning: Color,
    val onWarning: Color,

    // ---- formatted descriptions (==highlight== and !!important!!, like richtext.css) ----------------
    val highlightBg: Color,
    val highlightFg: Color,
    val importantBg: Color,
    val importantFg: Color,

    // ---- one color per contributor on a plant profile: eight, then round again
    val contributors: List<ContributorPalette>,

    // ---- placeholder artwork per plant type ------------------------------------------------------
    val flowerTint: PlaceholderTint,
    val nonHerbalFlowerTint: PlaceholderTint,
    val defaultTint: PlaceholderTint
)

private val ContributorAccents = listOf(
    Color(0xFF4C9A2A), Color(0xFF2F86C8), Color(0xFFE0801F), Color(0xFF8E4FC2),
    Color(0xFFD6406B), Color(0xFF1E9C8F), Color(0xFFB89A14), Color(0xFF5A62C9)
)
private val ContributorsLight = listOf(
    ContributorPalette(Color(0xFFEAF6E1), ContributorAccents[0], Color(0xFF1F4D0E)),
    ContributorPalette(Color(0xFFE4F1FB), ContributorAccents[1], Color(0xFF0E3F66)),
    ContributorPalette(Color(0xFFFDEEDE), ContributorAccents[2], Color(0xFF6B3A07)),
    ContributorPalette(Color(0xFFF3E8FA), ContributorAccents[3], Color(0xFF46206B)),
    ContributorPalette(Color(0xFFFDE8EE), ContributorAccents[4], Color(0xFF6E1530)),
    ContributorPalette(Color(0xFFE0F5F3), ContributorAccents[5], Color(0xFF0B4741)),
    ContributorPalette(Color(0xFFFBF4D6), ContributorAccents[6], Color(0xFF574600)),
    ContributorPalette(Color(0xFFE9EAF8), ContributorAccents[7], Color(0xFF23286E))
)
private val ContributorsDark = listOf(
    ContributorPalette(Color(0xFF1F3318), ContributorAccents[0], Color(0xFFCDEEBD)),
    ContributorPalette(Color(0xFF17293A), ContributorAccents[1], Color(0xFFC5E3F8)),
    ContributorPalette(Color(0xFF3A2A16), ContributorAccents[2], Color(0xFFFBDCB8)),
    ContributorPalette(Color(0xFF2D1F3A), ContributorAccents[3], Color(0xFFE6CDF6)),
    ContributorPalette(Color(0xFF3A1A25), ContributorAccents[4], Color(0xFFF8C9D6)),
    ContributorPalette(Color(0xFF14322F), ContributorAccents[5], Color(0xFFBDEEE8)),
    ContributorPalette(Color(0xFF343013), ContributorAccents[6], Color(0xFFF1E6A3)),
    ContributorPalette(Color(0xFF212442), ContributorAccents[7], Color(0xFFCFD2F6))
)

private val PillMild = ToxicityPalette(Color(0xFFF2C94C), Color.Black, Color(0xFFF2C94C))
private val PillModerate = ToxicityPalette(Color(0xFFF2994A), Color.Black, Color(0xFFF2994A))
private val PillSevere = ToxicityPalette(Color(0xFFEB5757), Color.White, Color(0xFFEB5757))

private val FlowerTint = PlaceholderTint(Color(0xFFF7A8C4), Color(0xFFB0476F))
private val NonHerbalFlowerTint = PlaceholderTint(Color(0xFF6FCFC0), Color(0xFF1F6B6A))
private val DefaultTint = PlaceholderTint(Color(0xFF8FD16A), Color(0xFF2E7D32))

val LightExtraColors = ExtraColors(
    overlay = Color.Black,
    onOverlay = Color.White,
    photoShade = Color(0xFF081608),
    photoAccent = Color(0xFFC6E78F),
    forest = Color(0xFF2E6417),
    onForestChip = Color(0xFF234C11),
    photoBackdropStart = Color(0xFFDCEFD0),
    photoBackdropEnd = Color(0xFFB9DCA3),
    toxNone = ToxicityPalette(Color(0xFFE6F4E1), Color(0xFF2E6417), Color(0xFFB9DCA3)),
    toxMild = ToxicityPalette(Color(0xFFFFF6D6), Color(0xFF7A5B00), Color(0xFFF0DC8A)),
    toxModerate = ToxicityPalette(Color(0xFFFFE9D2), Color(0xFF9A4A00), Color(0xFFF3C08E)),
    toxSevere = ToxicityPalette(Color(0xFFFDE0DE), Color(0xFF8A2F2B), Color(0xFFF0AAA6)),
    toxUnknown = ToxicityPalette(Color(0xFFEEF1EF), Color(0xFF4D6054), Color(0xFFD3DAD5)),
    pillMild = PillMild,
    pillModerate = PillModerate,
    pillSevere = PillSevere,
    warning = ScanWarn,
    onWarning = LightOnSurface,
    highlightBg = Color(0xFFFFF3A3),
    highlightFg = Color(0xFF4A3B00),
    importantBg = Color(0x1FDC2626),
    importantFg = Color(0xFFA61B1B),
    contributors = ContributorsLight,
    flowerTint = FlowerTint,
    nonHerbalFlowerTint = NonHerbalFlowerTint,
    defaultTint = DefaultTint
)

val DarkExtraColors = ExtraColors(
    overlay = Color.Black,
    onOverlay = Color.White,
    photoShade = Color(0xFF081608),
    photoAccent = Color(0xFFC6E78F),
    // The light mode green is unreadable as text on a dark card, so dark mode uses the brand light green.
    forest = GreenLight,
    onForestChip = DarkOnSurface,
    photoBackdropStart = DarkPrimaryContainer,
    photoBackdropEnd = DarkSecondaryContainer,
    toxNone = ToxicityPalette(Color(0xFF1F3318), Color(0xFFB9DCA3), Color(0xFF3E6B2C)),
    toxMild = ToxicityPalette(Color(0xFF3A3210), Color(0xFFF0DC8A), Color(0xFF6B5B1E)),
    toxModerate = ToxicityPalette(Color(0xFF3D2A12), Color(0xFFF3C08E), Color(0xFF7A4E1E)),
    toxSevere = ToxicityPalette(Color(0xFF4A1F1D), Color(0xFFF0AAA6), Color(0xFF8A3A36)),
    toxUnknown = ToxicityPalette(Color(0xFF272E29), Color(0xFFC3CFC8), Color(0xFF47524B)),
    pillMild = PillMild,
    pillModerate = PillModerate,
    pillSevere = PillSevere,
    warning = ScanWarn,
    onWarning = LightOnSurface,
    highlightBg = Color(0xFF6B5A00),
    highlightFg = Color(0xFFFFF4B8),
    importantBg = Color(0x33F87171),
    importantFg = Color(0xFFFFB4B4),
    contributors = ContributorsDark,
    flowerTint = FlowerTint,
    nonHerbalFlowerTint = NonHerbalFlowerTint,
    defaultTint = DefaultTint
)

/** The palette of the [index]th contributor (0 = the primary description). The 9th reuses the 1st, like the website. */
fun ExtraColors.contributor(index: Int): ContributorPalette = contributors[Math.floorMod(index, contributors.size)]

val LocalExtraColors = staticCompositionLocalOf { LightExtraColors }

/** `MaterialTheme.extraColors.forest` ... the colors the Material scheme has no slot for. */
val MaterialTheme.extraColors: ExtraColors
    @Composable
    @ReadOnlyComposable
    get() = LocalExtraColors.current
