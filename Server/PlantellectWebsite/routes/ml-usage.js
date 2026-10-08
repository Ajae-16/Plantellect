/**
 * ML usage analytics, read from the Mongo feed (mongoose-schemas/Mlscan.js).
 *
 * Mounted at /admin/api/ml/usage and gated on view_logs — not access_admin. That
 * permission is granted to admin and superadmin but gated nothing until this,
 * so this is what makes the declared matrix live.
 *
 * No admin page in this plan: /admin/logs stays 404 and the data-perm="view_logs"
 * nav items stay href="#", so these are reachable by API only until a later plan
 * builds the UI.
 *
 * Every aggregation is computed on read. There is no rollup collection: the
 * volume is small (the quota is a ceiling, not a target) and a stored summary
 * would go stale the moment retention collects the underlying events.
 */
const express = require('express');
const mongoose = require('mongoose');

const { requirePermission } = require('../middleware/authMiddleware');
// listHandledDiscoverySpecies is the MySQL half of the gap feed: the species that
// already have a discovery report. `mysqlPool` is passed in explicitly so the
// executor is the one thing this route controls, and so the failing branch is
// reachable from a test with a deliberately broken executor instead of only by
// breaking a live table.
const { parsePaging, mysqlPool, listHandledDiscoverySpecies } = require('../config/mysql.js');
const { Mlscan } = require('../mongoose-schemas/Mlscan.js');
const settings = require('../config/settings');

const router = express.Router();

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Resolves ?month=, or explains why it cannot.
 *
 * A month older than the retention window is a 400, not an empty leaderboard:
 * "nobody scanned anything that month" is the opposite of the truth and would
 * send an admin chasing the wrong problem. Same reason the degraded flag exists.
 */
function resolveMonthRange(raw) {
    const now = new Date();
    const requested = raw ? String(raw) : monthKey(now);

    if (!MONTH_PATTERN.test(requested)) {
        return { error: `month must look like YYYY-MM, got "${requested}"` };
    }

    const cutoff = new Date(Date.now() - settings.ml.retentionDays * 24 * 60 * 60 * 1000);
    const earliest = monthKey(cutoff);
    if (requested < earliest) {
        return {
            error: `Month ${requested} is older than the ${settings.ml.retentionDays}-day retention window. ` +
                `The earliest queryable month is ${earliest}. Raise ML_RETENTION_DAYS to keep older data.`
        };
    }

    const [year, month] = requested.split('-').map(Number);
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);
    return { month: requested, start, end };
}

function parseLimit(raw, fallback, max) {
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

/**
 * Shared group stage: by species, counting scans and top-1 hits.
 *
 * topHitCount is what ranks the LEADERBOARD — a species that is confidently
 * identified beats one that merely appears often in the tail. The gap feed does
 * not use it for ranking (see GAPS_GROUP); it is still returned so the card can
 * show how confident the model was.
 *
 * `accountSet` adds the distinct-account count, which is the signal that
 * separates a real gap from noise. The count is stored in its own field rather
 * than sorted on the `$addToSet` array, because Mongo compares arrays
 * element-by-element: sorting on `accounts` directly would order by the FIRST
 * account id, not by how many there are, and the ranking would look plausible
 * while being meaningless.
 */
const SPECIES_GROUP = (predictionFilter) => ([
    ...(predictionFilter ? [{ $match: predictionFilter }] : []),
    {
        $group: {
            _id: '$predictions.scientificName',
            commonName: { $last: '$predictions.commonName' },
            scanCount: { $sum: 1 },
            topHitCount: { $sum: { $cond: [{ $eq: ['$predictions.rank', 1] }, 1, 0] } },
            accountSet: { $addToSet: '$accountId' },
            firstSeen: { $min: '$createdAt' },
            lastSeen: { $max: '$createdAt' },
            confidenceMin: { $min: '$predictions.confidence' },
            confidenceMax: { $max: '$predictions.confidence' },
            confidenceAvg: { $avg: '$predictions.confidence' }
        }
    },
    { $set: { accounts: { $size: '$accountSet' } } },
    { $sort: { topHitCount: -1, scanCount: -1 } }
]);

/**
 * The gap feed's own ranking: DISTINCT ACCOUNTS first, scan count second.
 *
 * Volume is what noise looks like. One account photographing the same blurry leaf
 * forty times produces forty scans of one species and is not evidence of anything;
 * twelve accounts each scanning a species once is. Ranking by scan count put the
 * first case at the top of the list, which is how an admin learns to skip the card.
 *
 * Scan count stays the tiebreaker because among equally-wide signals the louder
 * one is still the better lead.
 */
const GAPS_SORT = { accounts: -1, scanCount: -1 };

function speciesRow(row) {
    return {
        scientificName: row._id,
        commonName: row.commonName || '',
        scanCount: row.scanCount,
        topHitCount: row.topHitCount,
        // A COUNT, not the identity list: "how many different people hit this" is
        // the whole signal, and shipping the ids would turn a triage card into an
        // account-activity list for no gain.
        accounts: row.accounts,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
        confidenceMin: row.confidenceMin,
        confidenceMax: row.confidenceMax,
        confidenceAvg: row.confidenceAvg
    };
}

/**
 * The response for a failure that makes the answer WRONG rather than empty.
 *
 * Exported and used for both degraded branches so the two cannot drift: a Mongo
 * failure and a MySQL failure look the same to the reader, and they must. A gap
 * list that could not be filtered is not a gap list — it is a list of species the
 * team has already handled — so it ships no rows at all.
 */
function degradedGaps({ month, limit, error, excludedSpecies }) {
    return {
        degraded: true,
        error,
        month,
        limit,
        results: [],
        // null rather than 0: "we excluded nothing" and "we could not find out
        // what to exclude" are different, and only one of them is trustworthy.
        excludedSpecies: excludedSpecies === undefined ? null : excludedSpecies
    };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Monthly leaderboard: what people scan, most-confident first. */
router.get('/top', requirePermission('view_logs'), async (req, res) => {
    const range = resolveMonthRange(req.query.month);
    if (range.error) return res.status(400).json({ error: range.error });
    const limit = parseLimit(req.query.limit, 10, 50);

    try {
        const pipeline = [
            { $match: { createdAt: { $gte: range.start, $lt: range.end } } },
            { $unwind: '$predictions' },
            ...SPECIES_GROUP(null),
            { $limit: limit }
        ];
        const results = await Mlscan.aggregate(pipeline);
        res.json({ month: range.month, limit, results: results.map(speciesRow) });
    } catch (err) {
        console.error('ML usage top error:', err.message);
        res.json({ degraded: true, error: err.message, month: range.month, limit, results: [] });
    }
});

/**
 * Species people scan that the library genuinely does not have — the feed that
 * tells a botanist what to record next.
 *
 * linksResolved: true is required. When the plants lookup failed, every
 * prediction in that event has a null plantId for a reason that has nothing to
 * do with the library, and counting them would turn a database blip into a
 * wall of false gaps.
 *
 * reported: { $ne: true } is required for one reason. A gap that somebody has
 * already filed a discovery report for is a gap that is being worked on, and
 * listing it again as a fresh signal is the fastest way to make an admin stop
 * reading this page. `$ne` rather than `=== false` so documents written before
 * the field existed — which have no `reported` key at all — still count. It
 * covers reports filed straight from a scan; `handledSpecies` below covers the
 * rest, including reports filed from another page and ones decided long ago.
 *
 * This is an endpoint, not a work queue: nothing in this project acts on it yet.
 */
router.get('/gaps', requirePermission('view_logs'), async (req, res) => {
    const range = resolveMonthRange(req.query.month);
    if (range.error) return res.status(400).json({ error: range.error });
    const limit = parseLimit(req.query.limit, 25, 100);

    // Exclude what is already handled, BEFORE the aggregation and from MySQL,
    // because the names live there (approval_requests payloads) and the aggregation
    // runs in Mongo. There is no cross-database foreign key to hang this on.
    //
    // A failure here returns NO ROWS with degraded set. An unfiltered list is the
    // one outcome this must never produce: it is indistinguishable from a working
    // card, and it is full of species the team has already adjudicated. Note this
    // makes the endpoint depend on both databases.
    let handledSpecies;
    try {
        handledSpecies = await listHandledDiscoverySpecies(mysqlPool);
    } catch (err) {
        console.error('ML usage gaps exclusion error:', err.message);
        return res.json(degradedGaps({
            month: range.month,
            limit,
            error: 'Could not read the species that already have a discovery report, so this list is unfiltered.',
            excludedSpecies: null
        }));
    }

    try {
        const pipeline = [
            {
                $match: {
                    createdAt: { $gte: range.start, $lt: range.end },
                    linksResolved: true,
                    reported: { $ne: true }
                }
            },
            { $unwind: '$predictions' },
            ...SPECIES_GROUP({
                'predictions.plantId': null,
                'predictions.scientificName': { $nin: handledSpecies }
            }),
            { $sort: GAPS_SORT },
            { $limit: limit }
        ];
        const results = await Mlscan.aggregate(pipeline);
        res.json({
            month: range.month,
            limit,
            excludedSpecies: handledSpecies.length,
            results: results.map(speciesRow)
        });
    } catch (err) {
        console.error('ML usage gaps error:', err.message);
        res.json(degradedGaps({
            month: range.month,
            limit,
            error: err.message,
            excludedSpecies: handledSpecies.length
        }));
    }
});

/** One account's scan history. parsePaging clamps, so no clamp is needed here. */
router.get('/accounts/:accountId', requirePermission('view_logs'), async (req, res) => {
    const paging = parsePaging({ page: req.query.page, pageSize: req.query.pageSize });
    try {
        const [rows, totalRows] = await Promise.all([
            Mlscan.find({ accountId: req.params.accountId })
                .sort({ createdAt: -1 })
                .skip(paging.offset)
                .limit(paging.pageSize)
                .lean(),
            Mlscan.countDocuments({ accountId: req.params.accountId })
        ]);

        res.json({
            accountId: req.params.accountId,
            total: totalRows,
            page: paging.page,
            pageSize: paging.pageSize,
            // A read before the schema was ever written to, or after a Mongo
            // restart, is a gap in the answer, not an empty month.
            degraded: mongoose.connection.readyState !== 1,
            scans: rows.map((r) => ({
                id: String(r._id),
                createdAt: r.createdAt,
                status: r.status,
                topK: r.topK,
                modelVersion: r.modelVersion,
                inferenceMs: r.inferenceMs,
                linksResolved: r.linksResolved,
                    reported: Boolean(r.reported),
                predictions: (r.predictions || []).map((p) => ({
                    scientificName: p.scientificName,
                    commonName: p.commonName,
                    confidence: p.confidence,
                    plantId: p.plantId || null,
                    rank: p.rank ?? null
                }))
            }))
        });
    } catch (err) {
        console.error('ML usage account error:', err.message);
        res.json({
            degraded: true, error: err.message, accountId: req.params.accountId,
            total: 0, page: paging.page, pageSize: paging.pageSize, scans: []
        });
    }
});

module.exports = router;

// Exported alongside the router so a test can exercise the degraded RESPONSE
// itself, not just the helper that throws. The MySQL-failure branch is the one
// that must never answer with an unfiltered list, and asserting it only against a
// rejecting executor would leave the shape of the reply unchecked — which is the
// part an admin actually sees. Rejections are tested before reads throughout this
// project, and this is a refusal path.
module.exports.degradedGaps = degradedGaps;