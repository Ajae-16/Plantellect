package com.plantellect.mobileplantellect.ui.theme

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight

/**
 * Every typeface the app can use. Fonts are BUNDLED in the app (res/font): nothing is downloaded,
 * no Google Play services, works offline.
 *
 * TO ADD A FONT:
 *   1. add a line below: a name, the file prefix, a system font to use if the files are missing;
 *   2. put its TTF files in app/src/main/res/font named  <prefix>_regular.ttf, <prefix>_medium.ttf,
 *      <prefix>_semibold.ttf, <prefix>_bold.ttf  (lowercase; only the weights you have are needed);
 *   3. use it in a combo in TypeCombos.kt.
 * tools/install_fonts.py does the copying and renaming for the fonts listed here.
 *
 * A missing file is never an error: that weight is skipped, and with no file at all the family
 * draws as [fallback] (the phone's own font), so text is never missing.
 */
enum class AppFont(
    val displayName: String,
    /** Start of the file names in res/font, e.g. "open_sans" for open_sans_bold.ttf. Null = a font already on the phone. */
    val filePrefix: String?,
    val fallback: FontFamily
) {
    SYSTEM_SANS("System sans", null, FontFamily.SansSerif),
    SYSTEM_SERIF("System serif", null, FontFamily.Serif),

    // Neutral, very readable. Pairs well with Montserrat, Lato, Roboto.
    OPEN_SANS("Open Sans", "open_sans", FontFamily.SansSerif),

    // Geometric, bold and youthful. Pairs well with Open Sans, Roboto Slab.
    MONTSERRAT("Montserrat", "montserrat", FontFamily.SansSerif),

    // Friendly and professional, the Android default. Pairs well with Roboto Slab, Open Sans, Lato, Playfair Display.
    ROBOTO("Roboto", "roboto", FontFamily.SansSerif),
    ROBOTO_SLAB("Roboto Slab", "roboto_slab", FontFamily.Serif),

    // Warm and corporate. Pairs well with Montserrat, Roboto, Open Sans, Playfair Display.
    LATO("Lato", "lato", FontFamily.SansSerif),

    // Elegant serif. Lighter weights look best. Pairs well with Roboto, Lato, Open Sans, Montserrat.
    PLAYFAIR_DISPLAY("Playfair Display", "playfair_display", FontFamily.Serif),

    // Helvetica is a licensed font and Android does not ship it: the phone's own sans-serif is the closest match.
    HELVETICA("Helvetica", null, FontFamily.SansSerif);

    /** The family to draw with, built from the files found in res/font. */
    fun family(context: Context): FontFamily {
        val prefix = filePrefix ?: return fallback
        val fonts = FILE_SUFFIX.mapNotNull { (weight, suffix) ->
            val id = context.resources.getIdentifier("${prefix}_$suffix", "font", context.packageName)
            if (id != 0) Font(id, weight) else null
        }
        return if (fonts.isEmpty()) fallback else FontFamily(fonts)
    }

    private companion object {
        /** Weight -> the end of the file name. */
        val FILE_SUFFIX = listOf(
            FontWeight.Normal to "regular",
            FontWeight.Medium to "medium",
            FontWeight.SemiBold to "semibold",
            FontWeight.Bold to "bold"
        )
    }
}
