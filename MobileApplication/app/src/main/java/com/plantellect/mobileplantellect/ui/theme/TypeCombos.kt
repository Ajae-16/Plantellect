package com.plantellect.mobileplantellect.ui.theme

import android.content.Context
import androidx.compose.material3.Typography as M3Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight

/**
 * Font combos the person can pick in Settings > Typography.
 *
 * A combo only chooses WHICH FONT and WHICH WEIGHT each kind of text uses. Sizes, line heights and
 * letter spacing stay in Type.kt, so changing a combo never moves the layout around much.
 *
 * ROLES (and the Material text styles each one drives; the table is [typographyFor]):
 *   h4        headlineLarge, displayLarge / Medium / Small      the biggest titles
 *   h5        headlineMedium                                    page headings
 *   h6        headlineSmall, titleLarge                         section headings
 *   subtitle  titleMedium, titleSmall                           card titles, sub-headings
 *   body      bodyLarge, bodyMedium                             paragraphs
 *   caption   bodySmall                                         small print
 *   label     labelLarge, labelMedium, labelSmall               buttons, chips, tags
 *
 * TO ADD A COMBO: copy one entry below, give it a new NAME, a title and a one-line blurb, and set the
 * font + weight of each role with f(...). It appears in Settings by itself. Never rename an existing
 * NAME: it is what the phone saved.
 * TO CHANGE ONE ROLE: edit one f(...) line.
 */
class RoleFont(val font: AppFont, val weight: FontWeight)

private fun f(font: AppFont, weight: FontWeight = FontWeight.Normal) = RoleFont(font, weight)

enum class TypeCombo(
    val title: String,
    val blurb: String,
    val h4: RoleFont,
    val h5: RoleFont,
    val h6: RoleFont,
    val subtitle: RoleFont,
    val body: RoleFont,
    val caption: RoleFont,
    val label: RoleFont
) {
    /** The look the app shipped with: the phone's own fonts, no font files needed. */
    DEFAULT(
        "Plantellect", "The original look: serif headings with simple, friendly text.",
        h4 = f(AppFont.SYSTEM_SERIF, FontWeight.Bold),
        h5 = f(AppFont.SYSTEM_SERIF, FontWeight.Bold),
        h6 = f(AppFont.SYSTEM_SERIF, FontWeight.SemiBold),
        subtitle = f(AppFont.SYSTEM_SANS, FontWeight.Bold),
        body = f(AppFont.SYSTEM_SANS),
        caption = f(AppFont.SYSTEM_SANS),
        label = f(AppFont.SYSTEM_SANS, FontWeight.Bold)
    ),

    PROFESSIONAL(
        "Professional", "Open Sans with Roboto and Montserrat. Clear, neutral, reliable.",
        h4 = f(AppFont.OPEN_SANS, FontWeight.Bold),
        h5 = f(AppFont.OPEN_SANS),
        h6 = f(AppFont.OPEN_SANS, FontWeight.Bold),
        subtitle = f(AppFont.ROBOTO, FontWeight.Medium),
        body = f(AppFont.OPEN_SANS),
        caption = f(AppFont.OPEN_SANS),
        label = f(AppFont.MONTSERRAT, FontWeight.SemiBold)
    ),

    ELEGANT(
        "Elegant", "Playfair Display headings with Lato text. Refined and modern.",
        h4 = f(AppFont.PLAYFAIR_DISPLAY, FontWeight.Bold),
        h5 = f(AppFont.PLAYFAIR_DISPLAY, FontWeight.SemiBold),
        h6 = f(AppFont.PLAYFAIR_DISPLAY, FontWeight.SemiBold),
        subtitle = f(AppFont.LATO, FontWeight.Bold),
        body = f(AppFont.LATO),
        caption = f(AppFont.LATO),
        label = f(AppFont.MONTSERRAT, FontWeight.Medium)
    ),

    MODERN(
        "Modern", "Montserrat headings with Open Sans text. Bold and youthful.",
        h4 = f(AppFont.MONTSERRAT, FontWeight.Bold),
        h5 = f(AppFont.MONTSERRAT, FontWeight.SemiBold),
        h6 = f(AppFont.MONTSERRAT, FontWeight.SemiBold),
        subtitle = f(AppFont.OPEN_SANS, FontWeight.SemiBold),
        body = f(AppFont.OPEN_SANS),
        caption = f(AppFont.OPEN_SANS),
        label = f(AppFont.MONTSERRAT, FontWeight.SemiBold)
    ),

    FRIENDLY(
        "Friendly", "Lato with Roboto. Warm and approachable.",
        h4 = f(AppFont.LATO, FontWeight.Bold),
        h5 = f(AppFont.LATO, FontWeight.Bold),
        h6 = f(AppFont.LATO, FontWeight.Bold),
        subtitle = f(AppFont.ROBOTO, FontWeight.Medium),
        body = f(AppFont.LATO),
        caption = f(AppFont.LATO),
        label = f(AppFont.ROBOTO, FontWeight.Medium)
    ),

    CLASSIC(
        "Classic", "Roboto Slab headings with Roboto text. Sturdy and bookish.",
        h4 = f(AppFont.ROBOTO_SLAB, FontWeight.Bold),
        h5 = f(AppFont.ROBOTO_SLAB, FontWeight.Bold),
        h6 = f(AppFont.ROBOTO_SLAB, FontWeight.SemiBold),
        subtitle = f(AppFont.ROBOTO, FontWeight.Medium),
        body = f(AppFont.ROBOTO),
        caption = f(AppFont.ROBOTO),
        label = f(AppFont.ROBOTO, FontWeight.Medium)
    ),

    NEUTRAL(
        "Neutral", "Helvetica style headings with Roboto text. Plain and versatile.",
        h4 = f(AppFont.HELVETICA, FontWeight.Bold),
        h5 = f(AppFont.HELVETICA, FontWeight.Bold),
        h6 = f(AppFont.HELVETICA, FontWeight.Bold),
        subtitle = f(AppFont.ROBOTO, FontWeight.Medium),
        body = f(AppFont.ROBOTO),
        caption = f(AppFont.ROBOTO),
        label = f(AppFont.ROBOTO, FontWeight.Medium)
    );

    companion object {
        /** The saved name back to a combo; anything unknown (an old or removed combo) gives the default. */
        fun fromName(name: String?): TypeCombo = entries.firstOrNull { it.name == name } ?: DEFAULT
    }
}

/**
 * Applies [combo] to [base] (the sizes in Type.kt). This table is the only place that says which
 * role drives which Material text style.
 */
fun typographyFor(combo: TypeCombo, context: Context, base: M3Typography = Typography): M3Typography {
    val families = HashMap<AppFont, FontFamily>()
    fun TextStyle.withRole(role: RoleFont): TextStyle = copy(
        fontFamily = families.getOrPut(role.font) { role.font.family(context) },
        fontWeight = role.weight
    )
    return base.copy(
        displayLarge = base.displayLarge.withRole(combo.h4),
        displayMedium = base.displayMedium.withRole(combo.h4),
        displaySmall = base.displaySmall.withRole(combo.h4),
        headlineLarge = base.headlineLarge.withRole(combo.h4),
        headlineMedium = base.headlineMedium.withRole(combo.h5),
        headlineSmall = base.headlineSmall.withRole(combo.h6),
        titleLarge = base.titleLarge.withRole(combo.h6),
        titleMedium = base.titleMedium.withRole(combo.subtitle),
        titleSmall = base.titleSmall.withRole(combo.subtitle),
        bodyLarge = base.bodyLarge.withRole(combo.body),
        bodyMedium = base.bodyMedium.withRole(combo.body),
        bodySmall = base.bodySmall.withRole(combo.caption),
        labelLarge = base.labelLarge.withRole(combo.label),
        labelMedium = base.labelMedium.withRole(combo.label),
        labelSmall = base.labelSmall.withRole(combo.label)
    )
}

@Composable
fun rememberTypography(combo: TypeCombo): M3Typography {
    val context = LocalContext.current
    return remember(combo) { typographyFor(combo, context.applicationContext) }
}
