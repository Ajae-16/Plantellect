package com.plantellect.mobileplantellect.data.logic

/**
 * Contributor descriptions (uses, benefits, things to watch out for) as the website writes them.
 * A port of public/javascript/richtext.js: the server stores plain TEXT, this turns it into blocks
 * and marks. It knows nothing about colors or fonts; ui/screen/RichTextView.kt draws it.
 *
 * What a contributor can type:
 *   Enter                new line (kept)
 *   \n   (backslash n)   next paragraph          a blank line   next paragraph
 *   *- item              bullet list             1. item        numbered list
 *   **bold**   *italic*   __underline__   ~~strike~~
 *   ==highlight==        yellow marker
 *   !!important!!        red emphasis
 */
enum class RichMark { BOLD, ITALIC, UNDERLINE, STRIKE, HIGHLIGHT, IMPORTANT }

/** [start] until [end] (end excluded) of the line's text carries [mark]. Spans may overlap. */
data class RichSpan(val start: Int, val end: Int, val mark: RichMark)

/** One line of text, already free of the typed marks. */
data class RichLine(val text: String, val spans: List<RichSpan>)

sealed interface RichBlock {
    /** Lines of one paragraph; the website joins them with a line break. */
    data class Paragraph(val lines: List<RichLine>) : RichBlock
    data class Bullets(val items: List<RichLine>) : RichBlock
    data class Numbered(val items: List<RichLine>) : RichBlock
}

object RichText {
    // The same patterns, in the same order, as richtext.js (order matters: ** before *).
    private val BOLD = Regex("""\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*""")
    private val UNDERLINE = Regex("""__(?=\S)([\s\S]+?)(?<=\S)__""")
    private val STRIKE = Regex("""~~(?=\S)([\s\S]+?)(?<=\S)~~""")
    private val HIGHLIGHT = Regex("""==(?=\S)([\s\S]+?)(?<=\S)==""")
    private val IMPORTANT = Regex("""!!(?=\S)([\s\S]+?)(?<=\S)!!""")
    private val ITALIC = Regex("""(^|[^*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)""")

    // A bullet is "*- " (or a pasted "• "). A lone "-" is NOT a bullet, so "well-known" stays as typed.
    private val BULLET = Regex("""^\s*(?:\*-|•)\s+""")
    private val NUMBER = Regex("""^\s*\d+[.)]\s+""")

    // Private-use characters stand in for the website's tags while the patterns run.
    private const val OPEN = '\uE000'
    private const val CLOSE = '\uE001'
    private const val TYPE_BASE = '\uE010'

    private fun typeChar(mark: RichMark): Char = TYPE_BASE + mark.ordinal

    /** Line breaks as the server or phone gives them, with a typed "\n" read as a paragraph break. */
    private fun normalize(text: String?): String =
        (text ?: "")
            .filter { it !in '\uE000'..'\uE0FF' }
            .replace(Regex("\r\n?"), "\n")
            .replace("\\n", "\n\n")

    /** Text -> blocks. Empty or blank input gives an empty list. */
    fun parse(text: String?): List<RichBlock> {
        val source = normalize(text).trim()
        if (source.isEmpty()) return emptyList()
        val out = ArrayList<RichBlock>()
        source.split(Regex("\n{2,}")).forEach { block ->
            val lines = block.split('\n')
            var i = 0
            while (i < lines.size) {
                val line = lines[i]
                if (line.isBlank()) { i++; continue }
                val marker = when {
                    BULLET.containsMatchIn(line) -> BULLET
                    NUMBER.containsMatchIn(line) -> NUMBER
                    else -> null
                }
                if (marker != null) {
                    val items = ArrayList<RichLine>()
                    while (i < lines.size && marker.containsMatchIn(lines[i])) {
                        items += inline(lines[i].replace(marker, "").trim())
                        i++
                    }
                    out += if (marker === BULLET) RichBlock.Bullets(items) else RichBlock.Numbered(items)
                } else {
                    val para = ArrayList<RichLine>()
                    while (i < lines.size && lines[i].isNotBlank() &&
                        !BULLET.containsMatchIn(lines[i]) && !NUMBER.containsMatchIn(lines[i])
                    ) {
                        para += inline(lines[i].trim())
                        i++
                    }
                    out += RichBlock.Paragraph(para)
                }
            }
        }
        return out
    }

    /** The text without marks, on one line: for cards and other short snippets (RichText.plain on the website). */
    fun plain(text: String?): String =
        normalize(text)
            .replace(BOLD, "$1")
            .replace(UNDERLINE, "$1")
            .replace(STRIKE, "$1")
            .replace(HIGHLIGHT, "$1")
            .replace(IMPORTANT, "$1")
            .replace(ITALIC, "$1$2")
            .replace(Regex("""(?m)^\s*(?:\*-|•|\d+[.)])\s+"""), "")
            .replace(Regex("""\s*\n+\s*"""), " ")
            .trim()

    /** Inline marks of ONE line. */
    private fun inline(line: String): RichLine {
        var s = line
        for ((regex, mark) in listOf(
            BOLD to RichMark.BOLD, UNDERLINE to RichMark.UNDERLINE, STRIKE to RichMark.STRIKE,
            HIGHLIGHT to RichMark.HIGHLIGHT, IMPORTANT to RichMark.IMPORTANT
        )) {
            s = regex.replace(s) { m -> "$OPEN${typeChar(mark)}${m.groupValues[1]}$CLOSE${typeChar(mark)}" }
        }
        s = ITALIC.replace(s) { m ->
            "${m.groupValues[1]}$OPEN${typeChar(RichMark.ITALIC)}${m.groupValues[2]}$CLOSE${typeChar(RichMark.ITALIC)}"
        }
        return decode(s)
    }

    /** Turns the stand-in tags back into plain text plus spans. */
    private fun decode(s: String): RichLine {
        val text = StringBuilder()
        val spans = ArrayList<RichSpan>()
        val open = ArrayList<Pair<Char, Int>>()
        var i = 0
        while (i < s.length) {
            val ch = s[i]
            if ((ch == OPEN || ch == CLOSE) && i + 1 < s.length) {
                val type = s[i + 1]
                if (ch == OPEN) {
                    open += type to text.length
                } else {
                    val at = open.indexOfLast { it.first == type }
                    if (at >= 0) {
                        val start = open.removeAt(at).second
                        val mark = RichMark.entries.getOrNull(type - TYPE_BASE)
                        if (mark != null && text.length > start) spans += RichSpan(start, text.length, mark)
                    }
                }
                i += 2
            } else {
                text.append(ch)
                i++
            }
        }
        return RichLine(text.toString(), spans)
    }
}
