package com.plantellect.mobileplantellect.data.logic

/**
 * The editing side of rich text (the website's RichText.attach toolbar), without any of the
 * technical marks showing. While a person types, the text is held as plain words plus formatting
 * ([RichDoc]); only when it is handed back does it become the server's marked text
 * ("**bold**", "==highlight==" ...) with [RichEditing.toMarked].
 *
 * Reading goes the other way with [RichEditing.fromMarked]. Marks a person types by accident stay
 * as typed characters, which is fine: the server reads them like any other text.
 */
data class RichDoc(val text: String, val spans: List<RichSpan> = emptyList())

/** A new document and where the selection should be. */
data class EditResult(val doc: RichDoc, val selStart: Int, val selEnd: Int)

object RichEditing {
    /** A bullet line starts with this; the server reads a leading bullet character as a list item. */
    const val BULLET_PREFIX = "• "

    private val BULLET = Regex("^• ")
    private val NUMBER = Regex("^\\d+[.)] ")

    private fun prefixLen(line: String): Int =
        BULLET.find(line)?.value?.length ?: NUMBER.find(line)?.value?.length ?: 0

    private fun isBullet(line: String) = BULLET.containsMatchIn(line)
    private fun isNumbered(line: String) = NUMBER.containsMatchIn(line)

    // ---------------------------------------------------------------- reading

    /** Server text -> what the editor shows. Paragraphs are separated by a blank line. */
    fun fromMarked(marked: String?): RichDoc {
        val text = StringBuilder()
        val spans = ArrayList<RichSpan>()
        fun addLine(line: RichLine) {
            val offset = text.length
            text.append(line.text)
            line.spans.forEach { spans += RichSpan(offset + it.start, offset + it.end, it.mark) }
        }
        RichText.parse(marked).forEachIndexed { index, block ->
            if (index > 0) text.append("\n\n")
            when (block) {
                is RichBlock.Paragraph -> block.lines.forEachIndexed { i, line ->
                    if (i > 0) text.append('\n')
                    addLine(line)
                }
                is RichBlock.Bullets -> block.items.forEachIndexed { i, line ->
                    if (i > 0) text.append('\n')
                    text.append(BULLET_PREFIX)
                    addLine(line)
                }
                is RichBlock.Numbered -> block.items.forEachIndexed { i, line ->
                    if (i > 0) text.append('\n')
                    text.append("${i + 1}. ")
                    addLine(line)
                }
            }
        }
        return RichDoc(text.toString(), normalize(spans, text.length))
    }

    // ---------------------------------------------------------------- writing

    private class Iv(val mark: RichMark, val a: Int, val b: Int)

    private fun token(mark: RichMark): String = when (mark) {
        RichMark.BOLD -> "**"
        RichMark.ITALIC -> "*"
        RichMark.UNDERLINE -> "__"
        RichMark.STRIKE -> "~~"
        RichMark.HIGHLIGHT -> "=="
        RichMark.IMPORTANT -> "!!"
    }

    /** The editor's document -> the text the server stores. */
    fun toMarked(doc: RichDoc): String {
        val text = doc.text
        val out = StringBuilder()
        var lineStart = 0
        text.split('\n').forEachIndexed { index, line ->
            if (index > 0) out.append('\n')
            val lineEnd = lineStart + line.length
            val from = lineStart + prefixLen(line)          // the bullet / number is never inside a mark
            val pieces = ArrayList<Iv>()
            for (sp in doc.spans) {
                var a = maxOf(sp.start, from)
                var b = minOf(sp.end, lineEnd)
                while (a < b && text[a].isWhitespace()) a++      // a mark must touch its words
                while (b > a && text[b - 1].isWhitespace()) b--
                if (a < b) pieces += Iv(sp.mark, a - lineStart, b - lineStart)
            }
            out.append(markLine(line, pieces))
            lineStart = lineEnd + 1
        }
        return out.toString()
    }

    private val outerFirst = compareBy<Iv>({ it.a }, { -it.b }, { it.mark.ordinal })

    private fun markLine(line: String, pieces: List<Iv>): String {
        if (pieces.isEmpty()) return line

        // One interval per stretch of each mark.
        val merged = ArrayList<Iv>()
        pieces.groupBy { it.mark }.forEach { (mark, list) ->
            var current: Iv? = null
            for (iv in list.sortedBy { it.a }) {
                val c = current
                if (c != null && iv.a <= c.b) current = Iv(mark, c.a, maxOf(c.b, iv.b))
                else {
                    if (c != null) merged += c
                    current = iv
                }
            }
            current?.let { merged += it }
        }

        // Marks must nest like brackets; where two cross, the later one is cut in two at the crossing.
        val pending = ArrayList(merged.sortedWith(outerFirst))
        val done = ArrayList<Iv>()
        val stack = ArrayList<Iv>()
        var i = 0
        while (i < pending.size) {
            val iv = pending[i]
            i++
            while (stack.isNotEmpty() && stack.last().b <= iv.a) stack.removeAt(stack.lastIndex)
            val top = stack.lastOrNull()
            if (top != null && iv.b > top.b) {
                val head = Iv(iv.mark, iv.a, top.b)
                done += head
                stack += head
                val rest = ArrayList(pending.subList(i, pending.size))
                rest += Iv(iv.mark, top.b, iv.b)
                rest.sortWith(outerFirst)
                while (pending.size > i) pending.removeAt(pending.lastIndex)
                pending.addAll(rest)
            } else {
                done += iv
                stack += iv
            }
        }

        val opens = done.groupBy { it.a }
        val closes = done.groupBy { it.b }
        val sb = StringBuilder()
        for (pos in 0..line.length) {
            closes[pos]
                ?.sortedWith(compareByDescending<Iv> { it.a }.thenByDescending { it.mark.ordinal })
                ?.forEach { sb.append(token(it.mark)) }
            opens[pos]
                ?.sortedWith(compareBy<Iv>({ -it.b }, { it.mark.ordinal }))
                ?.forEach { sb.append(token(it.mark)) }
            if (pos < line.length) sb.append(line[pos])
        }
        return sb.toString()
    }

    // ---------------------------------------------------------------- spans

    /** Clamps, drops empty spans and merges touching or overlapping spans of the same mark. */
    private fun normalize(spans: List<RichSpan>, length: Int): List<RichSpan> {
        val out = ArrayList<RichSpan>()
        spans.map { RichSpan(it.start.coerceIn(0, length), it.end.coerceIn(0, length), it.mark) }
            .filter { it.start < it.end }
            .groupBy { it.mark }
            .forEach { (mark, list) ->
                var current: RichSpan? = null
                for (sp in list.sortedBy { it.start }) {
                    val c = current
                    if (c != null && sp.start <= c.end) current = RichSpan(c.start, maxOf(c.end, sp.end), mark)
                    else {
                        if (c != null) out += c
                        current = sp
                    }
                }
                current?.let { out += it }
            }
        return out.sortedWith(compareBy({ it.start }, { it.end }, { it.mark.ordinal }))
    }

    /** Replaces text[p, removedEnd) with [insert], keeping every span in step. [marks] format the inserted text. */
    private fun replace(doc: RichDoc, p: Int, removedEnd: Int, insert: String, marks: Set<RichMark>): RichDoc {
        val newText = doc.text.substring(0, p) + insert + doc.text.substring(removedEnd)
        val insertedEnd = p + insert.length
        val delta = insert.length - (removedEnd - p)
        val out = ArrayList<RichSpan>()
        for (sp in doc.spans) {
            val a = when {
                sp.start < p -> sp.start
                sp.start >= removedEnd -> sp.start + delta
                else -> insertedEnd
            }
            val b = when {
                sp.end <= p -> sp.end
                sp.end >= removedEnd -> sp.end + delta
                else -> p
            }
            if (a < b) out += RichSpan(a, b, sp.mark)
        }
        if (insert.isNotEmpty()) marks.forEach { out += RichSpan(p, insertedEnd, it) }
        return RichDoc(newText, normalize(out, newText.length))
    }

    // ---------------------------------------------------------------- typing

    /** Formats that apply to the NEXT character typed at [caret] (the bold word you are still typing). */
    private fun inherited(doc: RichDoc, caret: Int): Set<RichMark> =
        doc.spans.filter { it.start < caret && it.end >= caret }.map { it.mark }.toSet()

    /** Formats shown as active for a selection: [typing] (set by tapping a button with no selection) wins at a caret. */
    fun marksAt(doc: RichDoc, start: Int, end: Int, typing: Set<RichMark>? = null): Set<RichMark> {
        if (start == end) return typing ?: inherited(doc, start)
        return RichMark.entries.filter { mark ->
            doc.spans.any { it.mark == mark && it.start <= start && it.end >= end }
        }.toSet()
    }

    /** Turns [mark] on, or off when the whole selection already has it. */
    fun toggle(doc: RichDoc, start: Int, end: Int, mark: RichMark): RichDoc {
        if (start >= end) return doc
        val covered = doc.spans.any { it.mark == mark && it.start <= start && it.end >= end }
        val spans = ArrayList<RichSpan>()
        if (covered) {
            for (sp in doc.spans) {
                if (sp.mark != mark || sp.end <= start || sp.start >= end) { spans += sp; continue }
                if (sp.start < start) spans += RichSpan(sp.start, start, mark)
                if (sp.end > end) spans += RichSpan(end, sp.end, mark)
            }
        } else {
            spans += doc.spans
            spans += RichSpan(start, end, mark)
        }
        return RichDoc(doc.text, normalize(spans, doc.text.length))
    }

    /**
     * The field's text changed to [newText] with the caret at [caret]. Spans follow the edit, new text
     * takes [typing] (or the format around the caret), and Enter inside a list continues the list.
     */
    fun onTextChanged(old: RichDoc, newText: String, caret: Int, typing: Set<RichMark>?): EditResult {
        var p = 0
        val shortest = minOf(old.text.length, newText.length)
        while (p < shortest && old.text[p] == newText[p]) p++
        var s = 0
        while (s < old.text.length - p && s < newText.length - p &&
            old.text[old.text.length - 1 - s] == newText[newText.length - 1 - s]
        ) s++
        var removedEnd = old.text.length - s
        var insert = newText.substring(p, newText.length - s)

        // A plain insertion goes exactly where the caret says (the same letter next to it is ambiguous).
        if (removedEnd == p && insert.isNotEmpty()) {
            val at = caret - insert.length
            if (at in 0..old.text.length && newText.substring(0, at) + newText.substring(at + insert.length) == old.text) {
                p = at
                removedEnd = at
                insert = newText.substring(at, at + insert.length)
            }
        }

        if (insert == "\n" && removedEnd == p) {
            val lineStart = old.text.lastIndexOf('\n', p - 1) + 1
            val lineEndAt = old.text.indexOf('\n', p).let { if (it < 0) old.text.length else it }
            val before = old.text.substring(lineStart, p)
            val prefix = prefixLen(before)
            if (prefix > 0) {
                if (lineEndAt == p && before.length == prefix) {
                    // Enter on an empty list item ends the list.
                    return EditResult(replace(old, lineStart, p, "", emptySet()), lineStart, lineStart)
                }
                val next = nextPrefix(before.substring(0, prefix))
                val doc = replace(old, p, p, "\n$next", emptySet())
                val c = p + 1 + next.length
                return EditResult(doc, c, c)
            }
        }

        val marks = if (insert.isEmpty()) emptySet() else typing ?: inherited(old, p)
        val doc = replace(old, p, removedEnd, insert, marks)
        val c = caret.coerceIn(0, doc.text.length)
        return EditResult(doc, c, c)
    }

    private fun nextPrefix(prefix: String): String {
        if (prefix == BULLET_PREFIX) return prefix
        val digits = prefix.takeWhile { it.isDigit() }
        val rest = prefix.substring(digits.length)
        return "${(digits.toIntOrNull() ?: 0) + 1}$rest"
    }

    // ---------------------------------------------------------------- lists

    private class LinePlan(val start: Int, val oldLen: Int, val newPrefix: String) {
        val newLen get() = newPrefix.length
    }

    /** Bullets (or numbers) on every line the selection touches; applied again it takes them off. */
    fun toggleList(doc: RichDoc, selStart: Int, selEnd: Int, numbered: Boolean): EditResult {
        val text = doc.text
        val s = minOf(selStart, selEnd)
        val e = maxOf(selStart, selEnd)
        val firstStart = text.lastIndexOf('\n', s - 1) + 1
        val lastRef = if (e > s && e > 0 && text[e - 1] == '\n') e - 1 else e
        val lastEnd = text.indexOf('\n', lastRef).let { if (it < 0) text.length else it }

        val lines = ArrayList<Pair<Int, String>>()
        var at = firstStart
        text.substring(firstStart, lastEnd).split('\n').forEach { line ->
            lines += at to line
            at += line.length + 1
        }
        val allHave = lines.all { (_, line) -> if (numbered) isNumbered(line) else isBullet(line) }

        val plan = lines.mapIndexed { n, (start, line) ->
            val wanted = when {
                allHave -> ""
                numbered -> "${n + 1}. "
                else -> BULLET_PREFIX
            }
            LinePlan(start, prefixLen(line), wanted)
        }

        var result = doc
        for (line in plan.asReversed()) {
            if (line.oldLen == 0 && line.newPrefix.isEmpty()) continue
            result = replace(result, line.start, line.start + line.oldLen, line.newPrefix, emptySet())
        }

        fun mapPos(x: Int): Int {
            var cum = 0
            for (line in plan) {
                if (x < line.start) break
                if (x < line.start + line.oldLen) return line.start + cum + line.newLen
                cum += line.newLen - line.oldLen
            }
            return x + cum
        }
        return EditResult(result, mapPos(s), mapPos(e))
    }
}
