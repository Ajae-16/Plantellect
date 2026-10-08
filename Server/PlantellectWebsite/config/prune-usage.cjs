/**
 * Retention prune for the scan-usage bookkeeping and the discovery queue.
 *
 *   npm run db:prune:usage
 *
 * Manual and idempotent — nothing deletes these rows on its own. Reports the
 * counts it removed so a run is auditable, and removing 0 is a normal outcome,
 * not a failure.
 *
 * Three jobs, in three stores, because the three things expire differently:
 *   - ml_scan_usage  — pure enforcement bookkeeping with no analytical value.
 *   - mlscans        — the analytics feed. Mongo's TTL index collects these, but
 *                      it is backgrounded, so rows can outlive their window for
 *                      minutes or hours; this catches them deterministically.
 *   - discovery      — stale CLAIMS are released, and closed reports lose their
 *                      photos. The report row and its votes are kept forever.
 *
 * Only rows past settings.ml.retentionDays are touched, and both windows default
 * to one year, so every month of a calendar year stays queryable.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const mongoose = require('mongoose');

const settings = require('./settings');
const {
    purgeClosedDiscoveryPhotos,
    expireStaleDiscoveryClaims
} = require('./mysql');

function createPool() {
    return mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME,
        charset: 'utf8mb4',
        timezone: settings.system.timezone,
        connectionLimit: 2
    });
}

async function prune() {
    const cutoff = new Date(Date.now() - settings.ml.retentionDays * 24 * 60 * 60 * 1000);
    console.log('Database :', process.env.DB_NAME);
    console.log('Retention:', settings.ml.retentionDays, 'days');
    console.log('Cutoff   :', cutoff.toISOString(), '\n');

    const pool = createPool();
    const conn = await pool.getConnection();
    let removedUsage = 0;
    let removedScans = 0;

    try {
        // windowStart is DATETIME in the pool's timezone, so compare against a
        // DATETIME literal rather than converting.
        const [usageResult] = await conn.query(
            'DELETE FROM ml_scan_usage WHERE windowStart < ?',
            [cutoff]
        );
        removedUsage = usageResult.affectedRows || 0;
        console.log(`  ml_scan_usage rows removed : ${removedUsage}`);
    } finally {
        conn.release();
        await pool.end();
    }

    // ---------- discovery ----------
    //
    // Stale claims are released BEFORE the photo purge, because both read
    // `claimedAt` and a released claim should not leave its report looking
    // worked-on. Both are independently idempotent: expiry moves rows whose
    // claimedAt has passed (already-released rows no longer match), and the purge
    // only deletes discovery_images rows that still exist.
    //
    // config/mysql.js opens its own pool, so this runs after the pool above is
    // closed rather than sharing its connection.
    let expiredClaims = 0;
    let purgedReports = 0;
    let purgedFiles = 0;
    try {
        const expired = await expireStaleDiscoveryClaims();
        expiredClaims = expired.expired;
        console.log(`  stale claims released     : ${expiredClaims}` +
            ` (older than ${settings.discoveries.claimStaleDays} days)`);

        const purged = await purgeClosedDiscoveryPhotos();
        purgedReports = purged.purgedRequests;
        purgedFiles = purged.removedFiles;
        console.log(`  closed reports purged    : ${purgedReports}`);
        console.log(`  report photos removed    : ${purgedFiles}` +
            ` (closed more than ${settings.discoveries.discoveryClosedPhotoDays} days ago;` +
            ' report rows and votes kept)');
    } catch (err) {
        // Not fatal: the usage prune above already committed, and a discovery
        // problem must not stop it being reported.
        console.error('  discovery prune failed:', err.message);
    }

    try {
        await mongoose.connect(settings.database.mongoUri);
        const { Mlscan } = require('../mongoose-schemas/Mlscan.js');
        const result = await Mlscan.deleteMany({ createdAt: { $lt: cutoff } });
        removedScans = result.deletedCount || 0;
        console.log(`  mlscans documents removed : ${removedScans}`);
    } catch (err) {
        console.error('  mlscans prune failed:', err.message);
        console.error('  (the MySQL prune above still completed)');
    } finally {
        await mongoose.disconnect().catch(() => {});
    }

    console.log(`\nPrune complete. ${removedUsage} usage row(s), ${removedScans} event(s) removed,` +
        ` ${expiredClaims} claim(s) released, ${purgedFiles} photo(s) deleted from ${purgedReports} closed report(s).`);
    return 0;
}

if (require.main === module) {
    prune()
        .then((code) => process.exit(code))
        .catch((err) => {
            console.error('Prune failed:', err.message);
            process.exit(1);
        });
}

module.exports = { prune };