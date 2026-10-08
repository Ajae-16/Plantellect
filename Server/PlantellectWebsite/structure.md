# Plantellect Website - Project Structure

```

PlantellectWebsite/
├── .env                      # Environment variables 
├── .env.example               # Environment template for version control
├── .gitignore                 # Excludes .env and sensitive files from Git
├── docker-compose.yml         # MySQL + MongoDB container orchestration
├── index.js                   # Main Express.js application entry point & server setup
├── package.json               # Node.js manifest with dependencies and scripts
├── package-lock.json          # Auto-generated exact dependency lockfile
│
├── administration/            # PROTECTED ADMINISTRATION VIEWS
│   ├── admin/                 # Admin dashboard & editor
│   │   ├── admin-dashboard.html  # Protected admin dashboard (role request review,
│   │   │                        #   YOUR ACCESS card, and the read-only species-gap card)
│   │   ├── admin-user.html       # Users & roles (server-side pagination, suspend/promote)
│   │   ├── admin-plants.html     # Pending plant requests + inventory with detail rows,
│   │   │                        #   the discovery-report audit queue (#discoveryQueue),
│   │   │                        #   and the Approval modes settings block (3 switches)
│   │   └── editor/
│   └── botanist/              # Botanist-specific administration
│       ├── certificates/      # Per-account certificate storage (accountId subfolders)
│       └── plant-images/      # Community-uploaded plant photos (plantId subfolders)
│
├── docs/                       # Project documentation (markdown)
│   ├── SCHEMA_EXTENSION_GUIDE.md              # How to add a column / FK / table to the schema
│   ├── DOCUMENT_5_IMPLEMENTATION.md           # Settings, quotas, and model selection in the database
│   ├── DOCUMENT_5_FINDINGS.md                 # Infrastructure and operational changes since document 4
│   ├── DOCUMENT_4_FINDINGS.md                 # Bugs 1-3 left behind (F1-F4) + the D1/D2 UI changes
│   ├── DOCUMENT_3_IMPLEMENTATION.md           # Approval modes, system reviewer, gap card
│   ├── DOCUMENT_3_FINDings.md                 # Same work: bugs found, fixes, judgement calls
│   ├── DOCUMENT_2_IMPLEMENTATION.md           # The discovery loop: what was built
│   ├── DOCUMENT_2_FINDings.md                 # Same work: bugs found, fixes, judgement calls
│   ├── DOCUMENT_1_IMPLEMENTATION.md           # Plant capture & record UI: what changed
│   └── DOCUMENT_1_FINDings.md                 # Same work: bugs found, fixes, judgement calls
│
├── config/                    # Database connection, settings & schema configurations
│   ├── mongo.js               # MongoDB connection (via Mongoose)
│   ├── mysql.js               # MySQL pool + all query helpers (users, plants, requests,
│   │                          #   public reads, scan quota, owner-scoped image reads)
│   ├── ids.js                 # Primary key generation: prefix registry, atomic nextId/nextKey/insertRow
│   ├── settings.js            # Centralized settings (timezone, certificates, plantImages,
│   │                          #   pagination, terms, sessions, ml quotas + retention)
│   ├── upload.js              # Shared multer factories (certificate + plant image uploaders)
│   │                          #   and handleUploadError() -> 400 with the real limit
│   ├── approval-mode.js        # Manual/automatic approval switches (3 rbac_meta keys, all '0')
│   │                          #   + the system reviewer identity and its audit vocabulary.
│   │                          #   Takes an executor, never imports mysql.js: the mode is read
│   │                          #   INSIDE the transaction that decides on it.
│   ├── seed.cjs               # Full schema + minimal seed: roles, permissions, plant types,
│   │                          #   root account, the inactive system actor, the rbac_meta switches
│   ├── migrate.cjs            # npm run db:migrate — idempotent, non-destructive schema migration.
│   │                          #   Run it TWICE in a row; the 2nd run exercises every guard's
│   │                          #   already-applied branch.
│   ├── prune-usage.cjs        # npm run db:prune:usage — manual, idempotent retention prune for
│   │                          #   ml_scan_usage rows and Mongo mlscans events
│   ├── testingdb.cjs          # Optional demo data (npm run seed:test): botanists, plants, photos, review queue
│   └── reset.cjs              # Destructive drop script (npm run db:reset, asks before dropping).
│                              #   DROPS TABLES ONLY — clear plant-images/ and certificates/
│                              #   afterwards, or ids restart at plant_000001 and serve the
│                              #   previous database's photos. It prints that instruction.
├── middleware/                # Custom Express route middleware
│   └── authMiddleware.js      # requireAuth, requireRole, requirePermission, session refresh + status cut-off
│
├── mongoose-schemas/          # Mongoose schemas for MongoDB collections
│   ├── Authlog.js             # Auth + admin-action logging + logAuthEvent (swallow-and-log);
│   │                          #   approval_mode_changed is what records who flipped a switch
│   ├── Mlscan.js              # Per-prediction scan feed in mlscans + logMlScan; TTL index on
│   │                          #   expiresAt driven by settings.ml.retentionDays
│   └── Imgreview.js           # Image review decisions in imgreviews + logImageReview; one row
│                              #   per decision (not per image); no storedPath by design.
│                              #   approvalMode / decisionSource / ruleVersion / reason are free
│                              #   text validated by the writer, NOT Mongoose enums
│
├── routes/                    # Express route handlers / API controllers
│   ├── admin.js               # Admin HTML pages + /admin/api/* JSON (users, plants, requests,
│   │                          #   discovery reports, votes, override, ml coverage,
│   │                          #   approval modes)
│   ├── discoveries.js         # /api/discoveries: the discovery loop. Report filing, botanist
│   │                          #   queue + count, reporter's own view, the owner AND botanist
│   │                          #   photo routes, and claim/resolve/vote/cancel. A separate router
│   │                          #   from plants.js on purpose: a different feature with a different
│   │                          #   permission model, and a claim there would also put /count and
│   │                          #   /images/:imageId behind /:plantId
│   ├── auth.js                # Public auth: register (consent + certificate), login, logout, me
│   ├── plants.js              # Public plant reads + image serving, owner-scoped image serving,
│   │                          #   and botanist submissions
│   ├── botanists.js           # Public botanist profile
│   ├── role-requests.js       # Role request approve/deny + certificate download. The decision
│   │                          #   body is decideRoleRequest in mysql.js, shared with auto mode
│   ├── ml.js                  # ML inference proxy; scan_plant gate, bounded upload, quota, logs
│   └── ml-usage.js            # /admin/api/ml/usage: monthly /top, /gaps, per-account scans.
│                              #   Gated on view_logs. degraded:true instead of an empty list.
│                              #   /gaps ranks by DISTINCT ACCOUNTS and drops species that already
│                              #   have a discovery report, read from MySQL — so it needs both DBs
│                              #   and degrades to zero rows rather than an unfiltered list.
│
├── scripts/                   # Maintenance and verification tooling
│   ├── verify-db.cjs          # npm run verify:db — schema/permission/key-format assertions
│   ├── check-scripts.cjs      # npm run verify:scripts — script-order globals, inline block syntax,
    │   │                          #   scan-page id drift, retired #scan / openPlantScan hooks,
    │   │                          #   #discoveryReportCard OUTSIDE #scanUi, and the document 4
    │   │                          #   guards: admin-user.js not doubled, admin-discoveries.js
    │   │                          #   self-initialising, every el.* key declared, and F5's
    │   │                          #   single-auth-authority guard (no shared-nav page script may
    │   │                          #   fetch /api/auth/me, call checkAuth or render .auth-links;
    │   │                          #   every nav page must load sidebar.js undeferred)
│   └── api-test.cjs           # npm run test:api — end-to-end HTTP checks against a running server
│
├── ml/                        # FastAPI ML inference microservice
│   ├── requirements.txt       # Python dependencies (inference only)
│   ├── Dockerfile             # Container for CPU inference service
│   ├── model/
│   │   ├── main/              # Production model artifacts
│   │   │   ├── best_model.keras     # Trained Keras model (downloaded from Colab)
│   │   │   └── classes.json         # Class index → {scientific, common} mapping
│   │   └── mobile/            # Mobile-optimized model (TFLite)
│   │       └── model.tflite          # Quantized TFLite model for mobile
│   ├── app/                   # FastAPI application package (inference only)
│   │   ├── main.py            # FastAPI app entry point
│   │   ├── preprocess.py      # Image preprocessing
│   │   └── predict.py         # Inference logic
│   └── notebook/              # Colab training notebooks
│       ├── plantellect-cnn-training.ipynb    # Full training pipeline
│       └── plantellect-scanning-model.ipynb  # Inference reference
│
└── public/                    # PUBLIC STATIC ASSETS (served via express.static)
├── css/                   # Application stylesheets
    │   ├── admin               # admin style folder
    │   │   ├── admin-style.css    # Admin dashboard styles
    │   │   ├── admin-sidebar.css  # Admin sidebar + notification badges
    │   │   ├── admin-user.css     # Admin user styles
    │   │   ├── admin-plants.css   # Admin plant inventory styles + taxonomy-gap surface
    │   │   └── admin-theme.css
    │   ├── core/              # Core design tokens and shared base styles
    │   │   ├── variables.css      # Design tokens (colors, fonts, spacing)
    │   │   ├── base.css           # Reset, body/html, hero-container, header, nav, logo, auth-links
    │   │   ├── components.css     # Buttons, form inputs, modals, cards, popups
    │   │   └── sidebar.css        # Shared sidebar/drawer/hamburger/restricted-modal styles
    │   └── public/            # Public page specific styles
    │       ├── home.css           # Home + about page styles (hero content, about modal)
    │       ├── auth.css           # Auth page styles (login/register forms, tabs, modals)
    │       ├── profile.css        # Public profile page styles
    │       ├── capture-plant.css  # Scan page (capture-plant.html): upload area, preview, results
    │       ├── record.css         # Record page (record.html): tab strip, form grid, submissions
    │       ├── library.css        # Unified library page styles (container, sidebar, slider, cards)
    │       └── discoveries.css   # Discovery queue (discoveries.html): cards, status flags, photos
    ├── javascript/            # Client-side JavaScript files
    │   ├── home.js              # Home page: the carousel. No auth duty — sidebar.js owns the nav
    │   ├── auth-script.js       # Auth page logic (tabs, forms, validation, consent payload)
    │   ├── auth.js              # escapeHtml, plus checkAuth as a DELEGATING wrapper over
    │   │                        #   sidebar.js's plantAuth.ready (it owns no fetch of its own
    │   │                        #   except for a standalone page with no sidebar.js)
    │   ├── sidebar.js           # THE auth authority (one /api/auth/me fetch, the .auth-links
    │   │                        #   render on DOMContentLoaded, window.plantAuth.ready/user)
    │   │                        #   + the client-side sidebar renderer and its sessionStorage cache
    │   ├── nav-toggle.js        # Hamburger toggle for the library sidebar drawer
    │   ├── admin-sidebar.js     # Admin sidebar, drawer, and notification badges (loadNavBadges)
    │   ├── library-script.js    # Library: server-side search, card rendering, pagination
    │   ├── plant-profile.js     # Plant profile page (renders GET /api/plants/:plantId) and the
    │   │                        #   record_plant-gated Contribute button
    │   ├── botanist-profile.js  # Botanist profile page (bio, metrics, verified contributions
    │   │                        #   and a SEPARATE species-reported grid)
    │   ├── profile-script.js    # Profile page: the session from plantAuth.ready plus My reports
    │   │                        #   (GET /api/discoveries/mine, seven states)
    │   ├── logout.js            # Logout confirmation modal, API call, sessionStorage cleanup
    │   ├── photo-cache.js       # IndexedDB handoff: saveScanPhoto/takeScanPhoto/dropScanPhoto,
    │   │                        #   so a scanned File survives the page navigation to record.html
    │   ├── ml-client.js         # Frontend ML prediction helper (predictPlant, getModelInfo)
    │   ├── scan.js              # capture-plant.html controller (upload, camera, predict, results)
    │   │                        #   plus the discovery-report form, gated separately so a plain
    │   │                        #   `user` without scan_plant can still file one
    │   ├── discoveries-script.js # discoveries.html: the botanist queue and every per-report
    │   │                        #   action, refetched after each one. What you may DO with a
    │   │                        #   report is renderActions(); the Discovery actions menu
    │   │                        #   (Not a plant / Vote) is renderJudgementMenu() and is
    │   │                        #   shown on EVERY card — visibility is not permission
    │   ├── admin-discoveries.js  # The admin discovery-report audit queue on admin-plants.html.
    │   │                        #   SELF-INITIALISING: it calls initDiscoveryQueue() itself, so
    │   │                        #   no page may call it and no load order is assumed
    │   └── record-script.js     # record.html controller (tabs, new plant, contribute, submissions)
    │                            #   + the ?from=<requestId> discovery banner
    ├── resource/              # Images and media assets
    ├── about.html             # Public About page
    ├── auth.html              # Combined login/signup page (hash routing: #login, #register)
    ├── forgot-pass.html       # Password reset (NOT implemented — see Out of Scope)
    ├── home.html              # Main public homepage
    ├── library.html           # Unified plant library page (server-driven grid + pagination)
    ├── discoveries.html       # Botanist discovery queue (record_plant; admins triaged in /admin)
    ├── capture-plant.html     # Scan page (client gate on scan_plant; the APIs are the real gate)
    │                          #   #discoveryReportCard is a <details> and stays OUTSIDE #scanUi: a
    │                          #   plain user without scan_plant is exactly who must be able to report
    ├── record.html            # Botanist record page (tabbed: new / contribute / submissions)
    ├── profile.html           # Public Profile page (username, email, roles from /api/auth/me,
    │                          #   plus the "My reports" section)
    ├── plant-profile.html     # Plant detail page (description, parts, uses, benefits, warnings)
    └── botanist-profile.html  # Botanist profile page (bio, metrics, contributions)

```

## Key Guidelines

### Static vs. Protected Boundary

Anything placed directly inside `public/` is served statically via:
```js
app.use(express.static(path.join(__dirname, 'public')));
```

Restrict admin files by storing them inside `administration/admin/` and serving them strictly via `routes/admin.js` using authentication middleware. Botanist certificate files are stored in `administration/botanist/certificates/<accountId>/`; community-uploaded plant photos go in `administration/botanist/plant-images/<plantId>/`. Neither directory is statically served — certificates come through `routes/role-requests.js`, and plant images through `routes/plants.js`, which only returns rows with `status = 'approved'`.

Discovery-report photos go in `administration/botanist/plant-images/discoveries/<requestId>/`, deliberately **under the existing `plant-images` root**: no new directory is statically served, and the same `fileFilter` and `maxSizeBytes` apply unchanged, so a report cannot become a way to upload something the library would reject. Three routes read them and each has a different privacy rule: `GET /api/discoveries/images/:imageId` is owner-only (404 on a miss, never 403), `GET /api/discoveries/report-images/:imageId` is status-free for `record_plant`, and `GET /admin/api/discovery-images/:imageId` is admin-only. All three are `private, no-store`.

**Never store an uploaded file under a client-supplied filename.** `config/upload.js` writes a fresh UUID to disk and keeps the original name for display only; reads resolve from the database row, never from request input.

### Database

- `config/seed.cjs` owns the entire schema and creates it on first boot. It is a no-op once `roles` has rows.
- The seed is deliberately **minimal**: roles, permissions, the three plant types, and one root account (`superadmin` / `plantpassword`). Plant types count as essential because the botanist submission form and the plant type filter both read from that table.
- `npm run seed:test` (`config/testingdb.cjs`) adds optional demo data — botanists, users, plants, photos and a populated review queue. It is for local demos only, and it refuses to run twice.
- `npm run db:reset` drops everything (confirmation required), then `npm start` recreates it.
- **Schema changes on an existing database go through `npm run db:migrate`**, not a reset:
  `runSeed()` early-returns once `roles` has rows, so the seed will never apply a schema change.
  Run it **twice** — the second run exercises every guard's already-applied branch, which is
  the only practical way to catch a migration that applied its `ALTER` and then failed on a
  data statement. `index.js` runs a read-only preflight before `app.listen` and refuses to
  serve a stale schema with `Schema is out of date. Run: npm run db:migrate`; no DDL, no
  auto-repair. The scratch-machine loop is `npm run db:reset` → `npm start` → `npm run seed:test`
  → **`npm run db:migrate` (twice)** → `npm run verify:db` → `npm run verify:scripts`
  → `npm run test:api`. `db:migrate` is part of the loop, not an optional extra:
  the seed early-returns on an existing database, so without it `verify:db`
  asserts facts nothing in the loop can establish.
- **`npm run db:reset` drops tables only — it never touches the filesystem.** `id_counters`
  goes with them, so plant ids restart at `plant_000001` and the re-seed reuses the ids whose
  folders still hold the previous database's files. New `plant_images` rows then point at that
  path and the server happily serves the previous plant's approved photo as the new one's.
  Clearing `administration/botanist/plant-images/` and `administration/botanist/certificates/`
  is mandatory alongside a reset, not tidy-up; `reset.cjs` prints the instruction.
- `npm run verify:db` asserts key format, column naming, foreign key types, the permission matrix, and the table shapes.
- **A minimal install has an empty public library** until demo data is added or real botanists contribute. That is expected, not a bug.

### Primary Keys

Keys are `<short-prefix>_<exactly 6 digits>` — `acc_000001`, `pimg_000042`. The prefix is a short, recognisable abbreviation of the table's own name; the registry lives in `config/ids.js` and is shared by the seed and the insert helpers.

`discovery_votes` is deliberately absent from that registry: it has a composite primary key `(requestId, accountId)`, so it has no key column, no `id_counters` row and no key-format assertion — the same rule as `role_permissions` and `ml_scan_usage`. `discovery_images` IS registered, because it has a single key column.

**Key arithmetic stays in SQL.** mysql2 returns an `UNSIGNED BIGINT` column as a **string**, so `maxId + 1` in JavaScript is string *concatenation*: `'200005' + 1` is `'2000051'`, and every key allocated afterwards carries a seven-digit suffix. That is what `npm run db:migrate`'s `repairIdCounters` step exists to undo — it recomputes every counter as `MAX(suffix) + 1` in SQL, which cannot collide with a key already handed out.

**Keys are allocated in application code, not by MySQL triggers.** The project's database user only has privileges on its own schema, and MySQL 8 refuses to create triggers or stored functions while binary logging is on and `log_bin_trust_function_creators` is `OFF` (`ER_BINLOG_CREATE_ROUTINE_NEED_SUPER`). `config/ids.js` uses `LAST_INSERT_ID(expr)` for an atomic bump instead.

Because `LAST_INSERT_ID()` is connection-scoped, key generation and the insert must share one connection — use `mysqlPool.getConnection()` (ideally in a transaction) rather than `mysqlPool.query()`.

### Column Naming

All columns are camelCase. If a route returns raw column names, alias them in the `SELECT` so the JSON contract stays camelCase and a future column rename cannot break a page.

### Authentication & Session Model

- Sessions are stored in MongoDB via `connect-mongo` using `MONGO_URI`.
- Credentials are stored in MySQL (`accounts` table) and hashed with `bcrypt` in `passwordHash`.
- RBAC roles/permissions are stored in MySQL (`roles`, `permissions`, `role_permissions`).
- `accounts.status` (`active` / `inactive`) is a login gate. `refreshSession` re-reads it on every authenticated request, so suspending an account also cuts off an already-open session.
- The session id is regenerated on login to prevent session fixation.
- Terms and info-usage consent are recorded per account in `terms_acceptance`; the server requires both at registration.
- API routes answer with JSON `401`; only page loads redirect to `auth.html`.
- Client `sessionStorage` is only used for UI convenience. All authorization decisions happen server-side via middleware.

### RBAC Cache Invalidation

- `rbac_meta.permissions_version` is the source of truth for "stale" sessions.
- `requireAuth`/`requirePermission`/`requireRole` compare the session's `permissionsVersion` to the DB value; if stale, roles/permissions are reloaded into the session.
- Any role change bumps the version so the target's live session picks it up.

### Privileged Roles

- A role is **privileged** when it holds `access_admin` (currently `admin` and `superadmin`). This is derived, not hardcoded.
- The Users page's **Administrators card matches privileged roles**, so the panel still lists the account on a fresh install where the only admin is the superadmin. `counts.admin` uses the same rule, so the card and its table never disagree.
- Assigning or stripping a privileged role requires `admin_promote`, which only `superadmin` holds. `change_role` otherwise covers `user` ↔ `botanist`.
- A status or role change that would leave zero active superadmins is rejected (409), as is any self-demotion or self-suspension.

### Community Content Model

One plant is built by many botanists:

- `plants` holds identity and quantity only. There is no `status`, `location` or `type` column — type is a `plant_types` FK and archiving is a future stored procedure.
- `plant_description` has **one row per botanist**; `isPrimary` decides which one the public page renders.
- `plant_parts` has **one row per botanist**, holding height, width, color, shape and texture.
- `plant_images` holds many photos; only `status = 'approved'` rows are training data and publicly served.
- `plant_contributors` is the many-to-many join. `contributor` renders as "Recorded By", `reviewer` as "Reviewed By", `reporter` as "Reported By" (the account that filed the discovery report, which produced this plant). Rows are created on approval.
- Pending submissions live in `approval_requests.payload` only — no orphan rows exist until an admin approves.
- A `plant_addition` whose `scientificName` already exists is not an error: at approval it is attached to the existing plant and the request records a note.
- Approving the first description or image for a plant makes it primary. The approver is always recorded as a `reviewer`.
- A plant is publicly visible only while it has an approved primary description; the filter lives in SQL, not JavaScript.

### The Discovery Loop

A `user` flags a plant the model could not identify. A botanist claims it, records it, and an admin approves the record — **which is what closes the report.** There is no separate approval path for a report.

- `approval_requests` is still the single review queue. `requestType = 'plant_discovery'` rows carry `claimedBy`/`claimedAt`, `resolvedBy`/`resolvedAt`, `recordRequestId`, `disqualifiedBy`/`disqualifyReason`, and `claimSource`, all in one definition. `status` gained `cancelled` (the reporter withdrew it) and `rejected` (a botanist quorum said it is not a plant) — `rejected` is a *different event* from an admin's `denied`.
- `resolvedBy` is **orthogonal** to `recordRequestId`: a botanist can close a report while its record still awaits an admin. Neither implies the other.
- A report is CLOSED by approving its record. The same transaction sets the report's `status = 'approved'` and `targetPlantId`, and adds a `reporter` row for the person who filed it. `plant_discovery` is never approvable by itself — `approvePlantRequest` refuses it with a 400.
- `plant_discovery` is **excluded from `listMyRequests`** with an inclusion list, not `!=`. A botanist's own reports live under `GET /api/discoveries/mine`, and the existing submissions-status whitelist only covers three states.
- **A live claim closes the vote.** Live means the holder is `active` AND the claim is younger than `claimStaleDays`. A claim that goes stale stops being live, so a botanist who claims and goes quiet cannot block a rejection indefinitely.
- **A verdict is not a vote, and it releases the claim.** `disqualifyDiscovery` writes only `disqualifiedBy`/`disqualifiedAt`/`disqualifyReason`, and clears `claimedBy`/`claimedAt` in the *same* `UPDATE`. Recording a verdict is still closed — it requires holding the claim, so a finding has an author — but the claim does not survive it: because a live claim closes the vote, keeping it would leave the report visible, labelled and contestable while the only person entitled to vote was whoever had just made the call. A community judgement one member has to unlock is not a judgement. The verdict stays reversible by **any** botanist through `reinstate`, which also clears the ballots. One statement rather than a verdict followed by a release, or a second botanist could claim the report in between and have their claim silently erased.
- **Visibility is not permission.** The botanist queue shows a *Discovery actions* menu (Not a plant / Vote) on **every** card, including for botanists holding no claim, so the quorum is not reachable only by people willing to take ownership of work they do not want. Choosing a reason still needs the claim and the server says so. The admin override is a separate function, `adminDisqualifyDiscovery`, and never needed one.
- The quorum threshold is `max(2, min(DISCOVERIES_NOT_A_PLANT_VOTES, ceil(activeBotanists / 2)))`, so it always means "more than one opinion" and never "everybody". The floor of 2 is what stops one person closing a report alone. `activeBotanists` **excludes privileged roles** — they hold `record_plant` too, and counting them would put an administrator inside a quorum meant for botanists.
- `/vote` refuses with 409 below two active botanists rather than storing an inert ballot, and the admin override is the only closure path for a team that small. It is its own write: the botanist disqualify route requires holding the claim, and an admin never does.
- **Three photo routes, three gates, three mappers.** `listPendingDiscoveries` cards emit `/api/discoveries/report-images/:imageId` (`record_plant`), `listMyDiscoveryReports` emits `/api/discoveries/images/:imageId` (owner), and `listDiscoveryReports` emits `/admin/api/discovery-images/:imageId` (`access_admin`). They differ only in the gate, so sending the queue to the owner route is a 404 and sending the reporter to the queue route silently leaks a pending report photo. `test:api` asserts all three are **distinct**.
- Both caps count **live** state, never history, and both are enforced in the same transaction as the write they guard — `SELECT ... FOR UPDATE` on the account row first, so a bare count-then-insert cannot be raced.
- `db:prune:usage` also releases stale claims and deletes the photos of reports closed longer than `DISCOVERY_CLOSED_PHOTO_DAYS`. The report row and its `discovery_votes` are kept indefinitely.

### Approval Modes

Every request type starts in manual approval, and an approval mode decides whether a human
reads a submission at all — so both switches and their consequences are documented here.

- Three `rbac_meta` keys, all `'0'`: `approval_auto_role_permission`,
  `approval_auto_plant_addition`, `approval_auto_plant_contribution`. **There is no
  `approval_auto_plant_discovery` and there must never be one.** A report carries no species
  of its own; its approval IS the approval of the record it produced, and that record is an
  ordinary `plant_addition`/`plant_contribution` covered by the other two keys.
- Every read and write of a switch goes through `config/approval-mode.js`. No route spells a
  key or the system account id inline. The mode is read **inside the transaction that decides
  on it** — a cached or route-supplied value is a value that was true when the process
  started, which is exactly how "I turned auto approval off and it kept approving" happens.
- `role_000005` / `system` is a MACHINE actor: **zero permissions** and seeded `inactive`, so
  `refreshSession`'s status check makes it impossible for it to authenticate. It exists only
  as a value in the reviewer columns, which are real foreign keys. Its `passwordHash` is a
  bcrypt hash of 32 random bytes, generated per install and discarded — a well-known hash
  becomes a real credential the day somebody flips `status` to debug something. It has **no
  `terms_acceptance` rows**: a machine consented to nothing, and `verify-db` scopes its
  consent assertion to exclude it rather than dropping the check.
- The account id is a **preference**, not a constant: `acc_000010` on a fresh install, and
  the next free id above the counter when that one is taken. `api-test.cjs` registers a
  throwaway account per run, so on a long-lived database a hard-coded id is simply taken.
  `getSystemReviewerId()` resolves the row holding the `system` role and caches it, and
  `index.js`'s preflight asserts it at boot so the failure is not silent.
- `approvalMode` is written on **every** approve and deny, under either mode, and is
  **derived from the reviewer** rather than passed in — the system account is the only
  reviewer an automatic decision can carry, so the column cannot disagree with `reviewedBy`.
  The admin queue reads that column, never Mongo, because `logImageReview` swallows its own
  errors and a logging outage must not make a decided request look undecided.
- Two rails are permanent and neither is switchable: **a discovery report is never approved or
  denied automatically**, and **a submitter's first submission of a given type is always
  reviewed by hand**. The first-submission check reads MySQL, not Mongo, precisely so a
  Mongo outage cannot make every submitter look new and silently disable the rail.
- Automatic mode **never denies** anything. `processNewRequest` delegates to the existing
  `approvePlantRequest` / `decideRoleRequest` bodies unchanged, so duplicate-species
  conversion, `ensurePrimaryContent` and the `hasContent` gate all still apply. The role
  decision body moved out of `routes/role-requests.js` into `decideRoleRequest` because there
  are now two callers and two copies of a privilege grant is how they drift.
- `GET/POST /admin/api/approval-modes` are `access_admin`. Flipping a switch writes
  `approval_mode_changed` to `authlogs` with the before/after per type — the toggling admin is
  the author of the **setting**, which is a different fact from being the author of any
  decision it then causes. It does **not** bump `permissions_version`: no permission changed,
  and that field exists to make RBAC caches correct.
- The switches live in `admin-plants.html` because approving happens there. The setting block
  names the consequence before the click, because enabling auto for a new-plant submission is
  a broader decision than "fewer approval clicks": it also covers records made FROM a
  discovery report, so a report can be resolved end to end with nobody reading the text, the
  measurements or the photos — and an approved photo is ML training data from that moment on.

### The Species-Gap Card

- `GET /admin/api/ml/usage/gaps` ranks by **distinct accounts** first and scan count second.
  Volume is what noise looks like: one account photographing the same leaf forty times is not
  evidence, twelve accounts each finding a species once is. The count is stored in its own
  field before the `$sort` because Mongo compares arrays element-by-element — sorting on the
  `$addToSet` array directly would order by the FIRST account id, which looks plausible while
  meaning nothing.
- `accounts` in the response is a **count, not an identity list**: "how many different people
  hit this" is the whole signal, and shipping the ids would turn a triage card into an
  account-activity list for no gain.
- Species that already have a discovery report are excluded, read from MySQL payloads via
  `listHandledDiscoverySpecies`. That makes the endpoint depend on **both** databases, and the
  failure mode to avoid is specific: a MySQL error returning an unfiltered list is
  indistinguishable from a working card and is full of species the team already adjudicated.
  So the helper throws rather than returning `[]`, and the route answers `degraded: true` with
  **no rows**. The same builder serves the Mongo-failure branch so the two cannot drift.
- The card on `admin-dashboard.html` is **read-only**: no approve, no record, no link to the
  library search. It is gated on `view_logs` server-side, and a 403 renders nothing rather
  than an error — a viewer who may not see scan data is not in a broken state. It also checks
  `degraded` BEFORE `results.length`, because a degraded response carries an empty array and
  checking the length first would print "No gaps found" when the truth is "we could not find out".

### Environment Security

Keep `.env` strictly at the project root and ensure it remains listed in `.gitignore` so secrets are never pushed to repository commits.
