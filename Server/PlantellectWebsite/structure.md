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
│   ├── admin/                 # Admin pages (served through authenticated routes)
│   │   ├── admin-dashboard.html  # Protected admin dashboard (stats,
│   │   │                        #   YOUR ACCESS card, read-only species-gap card,
│   │   │                        #   a "Scan Contributions Per Day" card that reads
│   │   │                        #   /admin/api/reporting/contributions (the SQL view
│   │   │                        #   vw_contributions_per_day),
│   │   │                        #   and statistics cards loaded from /admin/api/reporting/stats)
│   │   ├── admin-user.html       # Users & roles (server-side pagination, suspend/promote; Add user button and a
│   │                        #   view / edit dialog for email, username and name, gated by create_user / edit_user)
│   │   ├── admin-plants.html     # Pending plant requests + inventory with detail rows,
│   │   │                        #   the discovery-report audit queue (#discoveryQueue)
│   │   └── admin-settings.html   # Centralized admin settings (ML model, approval modes, quotas)
│   ├── inventory/user-images/ # Profile photos of users, <accountId>.webp, private (streamed by routes/profile.js)
│   ├── inventory/             # Plant inventory (community build: photos belong to users, not contributors)
│   │   └── plant-images/      # Community photos, one folder per review state:
│   │       ├── plants/{pending,approved,denied}/<requestId|plantId>/
│   │       └── discoveries/{pending,approved,denied}/<requestId>/
│   └── botanist/              # Legacy botanist administration (being retired)
│       └── certificates/      # Old certificate files, kept as history; nothing reads or writes them any more
│
├── docs/                      # Implementation notes and schema extension guide
│   ├── SCHEMA_EXTENSION_GUIDE.md
│   ├── DOCUMENT_1_IMPLEMENTATION.md / DOCUMENT_1_FINDINGS.md
│   ├── DOCUMENT_2_IMPLEMENTATION.md / DOCUMENT_2_FINDINGS.md
│   ├── DOCUMENT_3_IMPLEMENTATION.md / DOCUMENT_3_FINDINGS.md
│   ├── DOCUMENT_4_FINDINGS.md
│   └── DOCUMENT_5_IMPLEMENTATION.md / DOCUMENT_5_FINDINGS.md
├── key-guidelines.md          # Database key format and allocation rules

│
├── config/                    # Database connection, settings & schema configurations
│   ├── mongo.js               # MongoDB connection (via Mongoose)
│   ├── pool-mysql.js          # MySQL connection pool
│   ├── mysql.js               # Compatibility facade over the split query modules
│   ├── auth-mysql.js          # Accounts, roles, permissions and session guards
│   ├── registration-mysql.js  # Registration consent persistence
│   ├── user-mysql.js          # User listing, status and role changes, plus getUserDetail / createUser / updateUser
│   │                          #   (admin-made accounts get no consent rows; editing another admin needs admin_promote)
│   ├── profile-mysql.js       # The signed-in user's own profile: bio, password, one profile photo stored as
│   │                          #   administration/inventory/user-images/<accountId>.webp (profiles.imagePath;
│   │                          #   named after the user id; a replacement is built beside the old file, then renamed over it)
│   ├── profile-rules.js       # Pure bio / password validation (no DB), covered by tests/profile.test.js
│   ├── request-mysql.js       # Review queues and request decisions
│   ├── plant-mysql.js         # Plant reads, image access and approval writes. The admin photo count and
│   │                          #   getImageForServing ignore scan contributions (origin = 'record' only)
│   ├── public-mysql.js        # Public plant/contributor reads and ML coverage (coverage counts record photos only;
│   │                          #   every public photo query goes through visibleImageSql)
│   ├── record-mysql.js        # Plant validation and contributor submissions
│   ├── submission-mysql.js    # NOT REQUIRED BY ANYTHING: an older copy of record-mysql.js. Delete it.
│   ├── plant-manage-mysql.js  # Change requests (plant_change), split into two independent scopes, each its
│   │                          #   own request row with its own reason: 'base' (commonName, scientificName,
│   │                          #   the plant's own type, its own taxonomy; one pending per plant) and
│   │                          #   'description' (ONE contributor's own plant_description + plant_parts, named by
│   │                          #   payload.descriptionId; one pending per description). Neither scope can write
│   │                          #   into the other. getPlantEditable(plantId, accountId) returns only the caller's
│   │                          #   own descriptions; applyPlantChange runs in approvePlantRequest's transaction
│   ├── discovery-mysql.js     # Discovery reports, votes and image access
│   ├── description-vote-settings.js # The two admin-editable numbers (system_settings key descriptionVotes:
│   │                          #   upvoteAlert, downvoteHide >= 2), per-field fallback to settings.descriptionVotes, version-checked save.
│   ├── description-vote-mysql.js # Thumbs up / down on a plant description (description_votes, composite PK,
│   │                          #   no id_counters row). One ballot per account; cast / switch is idempotent, retract is
│   │                          #   its own call. settings.descriptionVotes.downvoteHide down votes HIDE the description
│   │                          #   (plant_description.hiddenAt) and hand the primary to the best remaining one; with none
│   │                          #   left the primary flag stays, so the plant is not dropped from the library.
│   │                          #   upvoteAlert up votes on a non-primary description raise an admin notice. Admin
│   │                          #   decisions: primary | restore (clears the down votes) | dismiss | remove (status 'rejected').
│   │                          #   feedbackClearedAt = when an admin last dismissed it, so only NEWER votes alert again.
│   │                          #   Totals come from the SQL view vw_description_votes (upVotes, downVotes per description), which the
│   │                          #   plant page's public "View votes" table also reads (counts + reasons + notes, never names).
│   │                          #   applyDownvoteThreshold() hides what already meets a LOWERED threshold. No rate limit on voting.
│   ├── scan-mysql.js          # Scan quota accounting
│   ├── setting-mysql.js       # System settings and upload limits
│   ├── approval-mysql.js      # Manual plant approval/denial transactions
│   ├── auto-approval-mysql.js # Automatic approval rules and first-submission rail
│   ├── shared-mysql.js        # Shared query constants/helpers
│   ├── ids.js                 # Primary key generation: prefix registry, atomic nextId/nextKey/insertRow
│   ├── settings.js            # Centralized settings (timezone, plantImages,
│   │                          #   pagination, terms, sessions, ml quotas + retention)
│   ├── limits.js              # Database-backed setting resolution and bounds
│   ├── ml-confidence.js       # ML confidence settings and validation; also the per-model
│   │                          #   scan-contribution keys (contributeMode off|on, contributeThreshold = lower bound 0.95, contributeUpperThreshold = upper bound 1, Daily/SpeciesCap; offers only inside the band)
│   ├── contribute-offer.js    # Pure: when a scan may be offered for training, and the signed
│   │                          #   short-lived offer token (HMAC from SESSION_SECRET, nothing stored)
│   ├── scan-contribution.js   # files a scanned photo as a private training-only photo (approved, (describeHeldPhoto, a clear 'already contributed' message for the record   flow)
│   │                          #   publicVisible FALSE, candidate, origin scan_contribution). Verifies the offer,
│   │                          #   runs the ingest pipeline, enforces both daily caps, one transaction
│   ├── upload.js              # Shared multer factories (plant image uploader)
│   │                          #   and handleUploadError() -> 400 with the real limit
│   ├── approval-mode.js        # Manual/automatic approval switches (3 rbac_meta keys, all '0')
│   │                          #   + the system reviewer identity and its audit vocabulary.
│   │                          #   Takes an executor, never imports mysql.js: the mode is read
│   │                          #   INSIDE the transaction that decides on it.
│   ├── seed.cjs               # Full schema + minimal seed: roles, permissions, plant types,
│   │                          #   root account, the inactive system actor, the rbac_meta switches,
│   │                          #   and 5 read-only reporting views (vw_active_users,
│   │                          #   vw_recent_plants, vw_total_plants, vw_pending_requests,
│   │                          #   vw_contributions_per_day: scan contributions per site day, with the
│   │                          #   TZ_OFFSET written into it).
│   │                          #   plant_images carries origin ('record' | 'scan_contribution', default
│   │                          #   'record'), contributionConfidence DECIMAL(5,4) and contributionModelId
│   │                          #   VARCHAR(64) for scan contributions (scan-contribution plan
│   │                          #   columns only, nothing reads or writes them yet)
│   ├── migrate.cjs            # npm run db:migrate — idempotent, non-destructive schema migration.
│   │                          #   Run it TWICE in a row; the 2nd run exercises every guard's
│   │                          #   already-applied branch. Includes migratePlantImageOrigin (adds the
│   │                          #   three scan-contribution columns to plant_images, each checked alone) and
│   │                          #   migrateViewContributionsPerDay (CREATE OR REPLACE of vw_contributions_per_day on
│   │                          #   every run, so a changed TZ_OFFSET is picked up; stops on a bad TZ_OFFSET).
│   ├── migrate-record.cjs     # Targeted plant-record schema migration
│   ├── prune-usage.cjs        # npm run db:prune:usage — manual, idempotent retention prune for
│   │                          #   ml_scan_usage rows and Mongo mlscans events
│   ├── testingdb.cjs          # Optional demo data (npm run seed:test): contributors, plants, photos, review queue
│   └── reset.cjs              # Destructive drop script (npm run db:reset, asks before dropping).
│                              #   DROPS TABLES ONLY — clear plant-images/
│                              #   afterwards, or ids restart at plant_000001 and serve the
│                              #   previous database's photos. It prints that instruction.
│   ├── public-images.js       # thumbnail + display WebP copies of approved, visible photos in
│   │                          #   public/resource/plant-images/{thumbnail,display}/<plantId>/<imageId>.webp, made FROM
│   │                          #   the master after an approval commits (and at startup for any that are missing),
│   │                          #   hashes stored on plant_images. visibleImageSql() is the one public-visibility rule.
│   │                          #   publicImageHandler() is the static mount: WebP only, nosniff, no listing, 404 for all else
│   ├── photo-visibility.js    # (listPlantPhotos can return one group + one page: group record | contributions, page size = setting plantImages.adminPhotosPerPage, 1-50, default 12; counts of both groups and each photo's training fields come with it)
│   ├── photo-visibility.js    # Admin control of one approved photo: hide / show (public copies), set primary,
│   │                          #   archive / unarchive. Hide and archive delete the public files BEFORE the database
│   │                          #   changes. Archive sets archivedAt / archivedBy / archiveReason, hides the photo and
│   │                          #   hands the primary on; unarchive clears them and the photo stays hidden until Show.
│   │                          #   A scan contribution (origin = 'scan_contribution', a private training photo) is
│   │                          #   refused by show and primary (409, reason 'scan_contribution') before anything is
│   │                          #   built; archive / unarchive still work on it. The list also returns origin and the
│   │                          #   contribution's confidence and model id for the admin badge.
│   ├── training-photos.js     # trainingStatus / part / groupKey of approved photos (dataset page). Archived photos are
│   │                          #   not listed, not counted and not decided by "all candidates". trainingSummary also counts
│   │                          #   scan contributions per species (contribution, contributionCandidate) and takes an optional
│   │                          #   origin filter (ORIGINS: recorded photos or scan contributions); it never changes a status
│   ├── db-snapshot.js         # builds a numbered training snapshot from photos that are approved, included, not
│   │                          #   archived and still have a master
│   ├── reconcile.js           #  startup + nightly job that keeps public/resource/plant-images honest: deletes files with
│   │                          #   no visible record, regenerates missing copies and copies whose SHA-256 no longer matches the row
│   ├── retention.js           # nightly purge of masters of photos denied longer than deniedRetentionDays; keeps a
│   │                          #   denied_photo_tombstones row (hash + reason code, nothing personal). findTombstone() reads it
│   ├── maintenance.js         # runs reconcile at startup, reconcile + retention nightly (settings.maintenance.nightlyHour)
│   ├── image-files.js         # Photo folder layout + verified copy (copy, compare bytes, check the
│   │                          #   image parses, retry up to 5x, THEN delete the source) + FileMovePlan
│   ├── image-relocation.js    # Moves photos between pending/approved/denied, updates storedPath,
│   │                          #   flags fileIssue for the admin plants page, admin retry
│   ├── migrate-image-folders.cjs # node config/migrate-image-folders.cjs [--dry-run]: adds the
│   │                          #   fileIssue columns and files every existing photo. Run it TWICE.
├── middleware/                # Custom Express route middleware
│   └── authMiddleware.js      # requireAuth, requireRole, requirePermission, session refresh + status cut-off
│
├── mongoose-schemas/          # Mongoose schemas for MongoDB collections
│   ├── Authlog.js             # Auth + admin-action logging + logAuthEvent (swallow-and-log);
│   │                          #   approval_mode_changed is what records who flipped a switch
│   ├── Mlscan.js              # Per-prediction scan feed in mlscans + logMlScan (contributeOffered flag); TTL index on
│   │                          #   expiresAt driven by settings.ml.retentionDays
│   └── Imgreview.js           # Image review decisions in imgreviews + logImageReview; one row
│                              #   per decision (not per image); no storedPath by design.
│                              #   approvalMode / decisionSource / ruleVersion / reason are free
│                              #   text validated by the writer, NOT Mongoose enums
│
├── routes/                    # Express route handlers / API controllers
│   ├── admin.js               # Admin HTML pages + /admin/api/* JSON (users, plants, requests,
│   │                          #   discovery reports, votes, override, ml coverage,
│   │                          #   approval modes, reporting stats: /admin/api/reporting/stats,
│   │                          #   scan contributions per day: /admin/api/reporting/contributions (reads the view),
│   │                          #   photo hide / show / primary / archive / unarchive)
│   ├── discoveries.js         # /api/discoveries: the discovery loop. Report filing, contributor
│   │                          #   queue + count, reporter's own view, the owner AND contributor
│   │                          #   photo routes, and claim/resolve/vote/cancel. A separate router
│   │                          #   from plants.js on purpose: a different feature with a different
│   │                          #   permission model, and a claim there would also put /count and
│   │                          #   /images/:imageId behind /:plantId
│   ├── auth.js                # Public auth: register (consent; every sign-up is a plain user), login, logout, me
│   ├── description-votes.js   # GET /api/plants/:plantId/description-votes (up counts + own ballot + premade reasons),
│   │                          #   POST / DELETE /api/plants/:plantId/descriptions/:descriptionId/vote. Mounted BEFORE plants.js.
│   ├── admin-description-feedback.js # /admin/api/description-feedback: list, count, voters, and the four decisions.
│   │                          #   Worked on the Plants page ("Plant reports", before the discovery reports); the dashboard only
│   │                          #   shows a notification (admin-plant-report-notice.js) that links to /admin/plants#plantReportQueue.
│   │                          #   View = access_admin; decisions = manage_plant; each is written to the authlog.
│   │                          #   GET/POST /admin/api/description-votes/settings (admin_settings) edits the two thresholds.
│   ├── plant-changes.js       # GET /api/plants/:plantId/editable, POST /api/plants/:plantId/changes
│   │                          #   (body { base?, description? }: one request per scope sent).
│   │                          #   Mounted BEFORE routes/plants.js in index.js
│   ├── plants.js              # Public plant reads + image serving, owner-scoped image serving,
│   │                          #   contributor submissions, and public recent plants (/api/plants/recent)
│   ├── profile.js             # /api/profile (mobile app, signed-in user only): GET profile (bio, name, photoUrl),
│   │                          #   PUT /bio, POST /password (current password checked, 5 wrong guesses = 15 min lock),
│   │                          #   GET / POST / DELETE /photo (multipart field "image", 10 MB, same ingest as plant photos)
│   ├── contributors.js        # Public contributor profile (/api/contributors; /api/botanists kept as an alias)
│   ├── ml.js                  # ML inference proxy; scan_plant gate, bounded upload, quota, logs,
│   │                          #   contribute_offer in the /predict answer when eligible;
│   │                          #   POST /api/ml/contribute (photo + token -> config/scan-contribution.js)
│   └── ml-usage.js            # /admin/api/ml/usage: monthly /top, /gaps, per-account scans.
│                              #   Gated on view_logs. degraded:true instead of an empty list.
│                              #   /gaps ranks by DISTINCT ACCOUNTS and drops species that already
│   │                          #   have a discovery report, read from MySQL — so it needs both DBs
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
│   │   ├── efficientnetv2b1/  # Selectable model directory (model_id)
│   │   │   ├── plantellect_model.keras
│   │   │   ├── classes.json
│   │   │   └── preprocessing.json
│   │   └── convnexttiny/      # Second selectable model, same three-file layout
│   │       ├── plantellect_model.keras
│   │       ├── classes.json
│   │       └── preprocessing.json
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
    │       ├── capture-plant.css  # Scan page (capture-plant.html): upload area, preview, results, scan contribution card
    │       ├── record.css         # Record page (record.html): tab strip, form grid, submissions
    │       ├── library.css        # Unified library page styles (container, sidebar, slider, cards)
    │       └── discoveries.css   # Discovery queue (discoveries.html): cards, status flags, photos
├── javascript/            # Client-side JavaScript files
│   ├── home.js              # Home page: the carousel (loads newest plants from /api/plants/recent).
│                            #   No auth duty — sidebar.js owns the nav
    │   ├── auth-script.js       # Auth page logic (tabs, forms, validation, consent payload)
    │   ├── auth.js              # escapeHtml, plus checkAuth as a DELEGATING wrapper over
    │   │                        #   sidebar.js's plantAuth.ready (it owns no fetch of its own
    │   │                        #   except for a standalone page with no sidebar.js)
    │   ├── sidebar.js           # THE auth authority (one /api/auth/me fetch, the .auth-links
    │   │                        #   render on DOMContentLoaded, window.plantAuth.ready/user)
    │   │                        #   + the client-side sidebar renderer and its sessionStorage cache
    │   ├── nav-toggle.js        # Hamburger toggle for the library sidebar drawer
    │   ├── admin/               # Admin JavaScript modules
    │   │   ├── admin-sidebar.js     # Admin sidebar, drawer, and notification badges (loadNavBadges)
    │   │   ├── admin-settings.js    # Centralized admin settings (ES module)
    │   │   ├── settings-forms.js    # Settings drafts: Save/Cancel per section, undo per row, Save all/Cancel all bar (#sfAllBar); percent helpers (UI shows 95, backend keeps 0.95)
│   │   ├── admin-topbar.js      # Admin topbar interactions
│   │   ├── admin-plant-images.js # Admin plant image review
│   │   ├── admin-contributions.js # Plants page "Scan Contributions" section: contributions grouped by assigned plant,
│   │   │                          #   paged; move photos to another plant, include a page in the dataset, exclude one
│   │   ├── admin-plant-manage.js # Plant detail and management interactions
│   │   ├── plant-changes.js     # Plant change form helpers
    │   │   ├── admin-discoveries.js # The admin discovery-report audit queue on admin-plants.html.
    │   │   │                        #   SELF-INITIALISING: it calls initDiscoveryQueue() itself, so
    │   │   │                        #   no page may call it and no load order is assumed
    │   │   └── admin-user.js        # Admin users page logic
    │   ├── library-script.js    # Library: server-side search, card rendering, pagination
    │   ├── plant-profile.js     # Plant profile page (renders GET /api/plants/:plantId) and the
    │   │                        #   record_plant-gated Contribute button
    │   ├── contributor-profile.js  # Contributor profile page (bio, metrics, contributions
    │   │                        #   and a SEPARATE species-reported grid)
    │   ├── profile-script.js    # Profile page: the session from plantAuth.ready plus My reports
    │   │                        #   (GET /api/discoveries/mine, seven states)
    │   ├── logout.js            # Logout confirmation modal, API call, sessionStorage cleanup
    │   ├── photo-cache.js       # IndexedDB handoff: saveScanPhoto/takeScanPhoto/dropScanPhoto,
    │   │                        #   so a scanned File survives the page navigation to record.html
    │   ├── ml-client.js         # Frontend ML prediction helper (predictPlant, getModelInfo, contributeScanPhoto:
    │   │                        #   posts the scanned File + contribute_offer.token to POST /api/ml/contribute; a
    │   │                        #   refusal is an Error carrying the server's message, .reason and .status)
    │   ├── scan.js              # capture-plant.html controller (upload, camera, predict, results) (the contribution card's Record it carries from=scan, and plantId when the species is in the library)
    │   │                        #   "Not identified?" report: uses the SCANNED photo (cached on the device through
    │   │                        #   PhotoCache.saveReportPhoto/takeReportPhoto/dropReportPhoto, a few days, dropped once sent) instead
    │   │                        #   of up to 3 uploads. A one-photo picker shows only when there is no scan. "What do you see?" is a
    │   │                        #   tick-box checklist whose choices are appended to the note as text. The tick "also use this photo
    │   │                        #   as a contribution image" sets discovery_images.allowContribution; without it a contributor cannot
    │   │                        #   attach the photo to a record (config/record-mysql.js refuses it, record-script hides it). Plant vs
    │   │                        #   Other plant is still decided later from the species, never by the reporter. No description needed.
    │   │                        #   plus the discovery-report form, gated separately so a plain
    │   │                        #   `user` without scan_plant can still file one
    │   │                        #   Scan contribution card (#scanContribute, scan-contribution): only when
    │   │                        #   /predict sent `contribute_offer` for the photo on screen. Help improve the ML posts the
    │   │                        #   SAME File object that was scanned (the offer is bound to its bytes); Record it is the
    │   │                        #   normal record link; Skip drops the token. Choosing another photo or scanning again
    │   │                        #   removes the card. The server decides every answer; the card only shows its message
    │   ├── discoveries-script.js # discoveries.html: the contributor queue and every per-report
    │   │                        #   action, refetched after each one. What you may DO with a
    │   │                        #   report is renderActions(); the Discovery actions menu
    │   │                        #   (Not a plant / Vote) is renderJudgementMenu() and is
    │   │                        #   shown on EVERY card — visibility is not permission
    │   └── record-script.js     # record.html controller (tabs, new plant, contribute, submissions) (?from=scan shows the description note, hint only, no prefill; Add to existing needs a description, sends fromScan=1)
    │                            #   + the ?from=<requestId> discovery banner
    ├── resource/              # Images and media assets
    ├── about.html             # Public About page
    ├── auth.html              # Combined login/signup page (hash routing: #login, #register)
    ├── forgot-pass.html       # Password reset (NOT implemented — see Out of Scope)
    ├── home.html              # Main public homepage
    ├── library.html           # Unified plant library page (server-driven grid + pagination)
    ├── discoveries.html       # Contributor discovery queue (record_plant; admins triaged in /admin)
    ├── capture-plant.html     # Scan page (client gate on scan_plant; the APIs are the real gate)
    │                          #   #scanContribute is the empty, hidden contribution card under #scanResults
    │                          #   #discoveryReportCard is a <details> and stays OUTSIDE #scanUi: a
    │                          #   plain user without scan_plant is exactly who must be able to report
    ├── record.html            # Contributor record page (tabbed: new / contribute / submissions) (#scanHandoffNote)
    ├── profile.html           # Public Profile page (username, email, roles from /api/auth/me,
    │                          #   plus the "My reports" section)
    ├── plant-profile.html     # Plant detail page (description, parts, uses, benefits, warnings)
    └── contributor-profile.html  # Contributor profile page (bio, metrics, contributions)

```


## Plant types and badges (per-plant model)

- Every plant OWNS exactly one `plant_types` row (typeName, isMedicinal, isHarmful,
  toxicityLevel, cautionNote). The name is free text and repeats across plants; only
  `typeId` is unique. Editing one plant's type can never touch another plant.
- `GET /api/plants/types` returns the NAMES in use (unique, A-Z, no counts) for the
  suggestion list and the library filter: `[{ typeName, label, ... }]`.
- A new plant's type row is created when an admin approves (approval-mysql.js), not at
  submission. A change request edits the plant's own row in place (plant-manage-mysql.js).
- One badge per plant: its type name, coloured by toxicityLevel (green none, yellow mild,
  orange moderate, red severe). Tokens: `public/css/core/variables.css` (--badge-*).
  Rules: `public/css/core/badges.css`. Markup + icon list: `public/javascript/badges.js`
  (`PlantBadge.html(name, level)`, `RoleBadge.html(role)`). Icons are glyphs today; set
  `USE_MATERIAL_SYMBOLS = true` there once the Material Symbols font is loaded on a page.
- The caution note belongs to the plant and is shown whether or not it is harmful.


## Rich text (contributor descriptions)

- Descriptions are plain TEXT in MySQL. `normalizeRichText` (config/shared-mysql.js) is used for uses /
  benefits / harmful / cautionNote instead of `normalizeName`, so Enter (line breaks) is stored. Use
  `normalizeName` only for names.
- Marks: Enter = new line, `\n` or a blank line = next paragraph, `*- ` bullet (a lone `-` is just a dash), `1. ` numbered,
  `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `==highlight==`, `!!important!!`.
- Display + editor helper: `public/javascript/richtext.js` (`RichText.html / render / plain / attach / openGuide`),
  styles `public/css/core/richtext.css` (imported by public-theme.css and admin-plants.css), colour tokens
  `--rt-*` and `--contrib-1..8` in core/variables.css. Mark a textarea `data-richtext` to get the toolbar,
  preview and the formatting guide. HTML is escaped first; only a fixed tag set is produced.
- Plant profile: primary description fills the cards; every other approved description is a colour-coded
  `.contrib-box` (8 colours, then repeats) under "More details from other contributors".

## Admin plant editing, withdraw, dashboard

- `config/admin-plant-edit-mysql.js` + routes in routes/admin.js: `GET /admin/api/plants/:id/edit`,
  `PATCH /admin/api/plants/:id` (base: names, type, taxonomy), `PATCH .../descriptions/:descriptionId`
  (one description + its measurements, `makePrimary`), `POST .../descriptions/:descriptionId/primary`.
- `config/withdraw-mysql.js`: `POST /api/plants/requests/:requestId/withdraw` (submitter only, pending only,
  status becomes 'cancelled', photos rejected and filed under plants/denied/).
- Dashboard: Sign-ins per day (`GET /admin/api/reporting/signins?days=`, from Authlog) and Most scanned plants
  (`/admin/api/ml/usage/top`) replace the species-gap card (`/gaps` endpoint still exists).
- Dashboard: Scan contributions per day (`GET /admin/api/reporting/contributions?days=`) only reads the SQL view
  `vw_contributions_per_day` (one row per site day with a contribution); the route fills empty days with zero and
  answers `degraded: true` (not a 500) while the view is missing.
- Dataset page, Database view: the stat tiles and the "Photos per species" table show scan contribution counts, and
  origin chips (All photos / Recorded / Scan contributions) filter that table through
  `GET /admin/api/dataset/db/summary?origin=`.

Scan Contributions section (Plants page, below Inventory; loads only when opened):
- `GET /admin/api/dataset/db/contributions/groups?page&review=1` plants with their contribution counts (10 per page).
- `GET /admin/api/dataset/db/contributions/:plantId/photos?page&review=1` one plant's photos, paged by the admin photo page size setting.
- `POST /admin/api/dataset/db/contributions/move` `{fromPlantId,toPlantId,imageIds}` changes `plantId` only (masters are not moved)
  and resets the photos to `candidate` so they are checked again.
- `POST /admin/api/dataset/db/contributions/include` `{plantId,imageIds,part?}` sets only `candidate` photos to `included`.
- `GET /admin/api/dataset/db/plant-search?q=` active plants for choosing a move target.
  Views need `access_admin`, changes need `manage_plant`. Logic is in `config/training-photos.js`.

## Other plant inbox, and choosing the model that compares photos (Dataset page, Database view)

Scan contributions the model called "Other plant" have no plantId (config/scan-contribution.js files them under
`plants/masters/_other_plant/`). The **Other plant** tab of the Database view is their own section:

- `GET  /admin/api/dataset/db/other-plant?page&review=1&sort=newest|oldest|confidence&min&modelId` one page of the inbox (page size = the admin "photos per page" setting)
- `GET  /admin/api/dataset/db/other-plant/ids` every id the same filter matches (at most `DATASET_MAX_BULK_MOVE`, default 500), for "Select all matching"
- `POST /admin/api/dataset/db/other-plant/assign` `{toPlantId, imageIds, include?, part?}` files the photos under ONE active plant in one transaction (all or none).
  They go back to `candidate`; `include: true` also sets the ones that were waiting to `included` (an excluded photo is moved but stays a candidate).
  The answer carries `plant`: its promotion state, so the page can offer **Promote now** (the existing `/api/dataset/species/promote`) the moment the minimum is reached.
  The master file is NOT moved: storedPath is all readers use, the same rule as the plants-page Move.
- `POST /admin/api/dataset/db/other-plant/suggest` `{imageIds}` which existing plants each photo looks like (score = mean of the closest 3 photos of that plant, best, margin)
- `POST /admin/api/dataset/db/other-plant/groups` `{imageIds?, threshold?}` look-alike groups (leader clustering, capped), each with the plants it looks like.
  A group that looks like no plant is a possible NEW species: create the plant through the normal record flow, then file the group under it.
- `GET  /admin/api/dataset/db/other-plant/embedders`, `POST .../embedder {kind}` which model compares the photos.
  Views need `access_admin`, changes need `manage_plant`; every change is in the authlog (`other_plant_assigned`, `embedder_changed`).
- Code: `config/training-photos.js` (listUnassigned, inboxFiles, bulkAssignUnassigned), `config/other-plant.js` (ML client, references, suggest, groups, assign),
  `config/species-promotion.js` (describePlants), `public/javascript/admin/admin-other-plant.js`. Settings: `settings.otherPlant`, `settings.dataset.maxBulkMove`.
- References a suggestion is compared with: per active plant up to `OTHER_PLANT_REFS_PER_PLANT` (6) photos that a person vouched for: recorded photos and INCLUDED
  contributions, never excluded ones and never contributions still waiting (they are the model's own guesses).
- The ML service keeps vectors by photo id, so each photo is sent once per embedder. One request embeds at most `OTHER_PLANT_EMBED_BUDGET` (80) missing photos and
  reports how many are left ("still to learn"); press the button again to continue.

ML service (`ml/app`):
- `dataset_tools/fingerprint.py`: embedder kinds `auto | mobilenet | thumb | saved | model:<id>`. `model:<id>` loads `<MODEL_ROOT>/<id>/plantellect_model.keras`,
  cuts it before the final Dense layer (the features the classifier decides from) and applies that model's own preprocessing.json. Its name carries the model id and file
  date, so a retrained model never mixes with old vectors. A named embedder that cannot load is an error, never a silent fallback (only `auto` falls back).
- `dataset_tools/vectors.py` (vector cache `photo_vectors.sqlite` + the admin's choice in `embedder.json`), `suggest.py` (pure ranking and clustering),
  `holder.py` (one embedder in memory, shared by every route), `embed_routes.py` (`/embed/*`).
- The chosen embedder is also used by the audit (`/dataset/audit`), the CLI (`--embedder model:convnexttiny`) and the approval look-alike hint (unless `LOOKALIKE_EMBEDDER` is set).
  `DATASET_EMBEDDER` is only the default until someone chooses on the page. Similarity thresholds (`cos_same`, look-alike 0.9, group %) were tuned for MobileNet:
  a model trained on your plants puts same-species photos closer together, so recheck them (the audit report's `nearestNeighbour`) before trusting a new embedder.

## Dataset audit: last run, 10-minute check, quick settings

- **Last run, visible to every admin.** The ML service writes `last_audit.json` (next to `index.sqlite`) when an audit starts and when it ends: who started it,
  when, the model, the thresholds used, the exit code. It survives a restart; a run that was going when the service stopped shows as interrupted (exit -2).
  The Dataset page shows it as a chip under the title that stays visible while every section is closed (grey none, blue spinning running, amber "just ran" for 10 minutes,
  green older, red failed). The page checks every 20 s (a running audit every 4 s) so another admin's run appears without a reload, and a change pulses. Times use the server's
  clock (`serverNow` in `/api/dataset/status`).
- **Confirm when it ran recently.** `POST /api/dataset/audit` answers 409 `{code:'recent_audit', lastRun}` when the last audit FINISHED normally less than
  `DATASET_AUDIT_RECENT_MINUTES` (10) ago, and starts nothing until the page asks again with `{confirm:true}`. It is decided on the server from the ML record
  (`config/dataset-audit.js`), so a stale page is covered too. A failed or interrupted audit can be retried at once; a running one is refused by the ML service.
- **Quick settings.** `GET/PUT /api/dataset/audit-settings` (ML `/dataset/audit-settings`): the model that compares photos (`auto | mobilenet | thumb | model:<id>`, the same
  choice as the Other plant tab: `embedder.json`) and the two similarity thresholds `cos_similar` / `cos_same` (`config.json`, 0.5 to 0.999, similar never above same).
  Edited in two places that always agree: the row above "Run audit now" (Dataset > Overview; Run audit saves unsaved edits first) and Settings > Dataset Audit.
  A change applies from the next audit; reports keep the values they used.
- Every collapsible section of the Dataset page starts closed (like the other admin pages); a tab opens its section.

## Several admins on the Dataset page: counters, change log, banner, locks

Built so that two admins can work on the dataset at once without silently overwriting each other. It INFORMS (counters, log,
banner) and it PREVENTS (locks). Code: `config/dataset-sync.js` (all server rules, database injected for tests),
`public/javascript/admin/dataset-sync.js` (`window.DatasetSync`: polling, banner, markers, claims), routes in `routes/admin-dataset.js`.

- **Tables** (one definition, `SCHEMA` in dataset-sync.js, read by BOTH `seed.cjs` and `migrate.cjs`; run `npm run db:migrate` twice):
  `dataset_sync` (one counter row per scope: `all`, `locks`, `folder`, `training`, `species`, `snapshots`, `audit`),
  `dataset_changes` (the change log: who, what, which item ids; `changeId` is the `all` counter's value, so there are no gaps or
  out-of-order ids), `dataset_locks` (short leases). No `id_counters` rows. Old log rows are pruned after `DATASET_SYNC_RETENTION_DAYS` (30).
- **Counters.** Every change that succeeds calls `track(req, { scopes, action, entityType, entityIds, summary })`, which writes one log
  row and moves `all` plus each named scope in one transaction. A page remembers the numbers it loaded with. Recording NEVER fails a
  request: with the tables missing it logs one warning and the page works as before.
- **`GET /admin/api/dataset/sync`** answers "did anything change?". Its ETag is built from the counters (and the poll interval)
  alone, so a page that sends it back in `If-None-Match` gets a bodyless 304 and nothing else is read. Only when a counter moved does it
  read the newest 40 log rows and the live claims.
- **Polling.** The server sends `pollSeconds` in every full answer. Step 1 (now): `DATASET_SYNC_POLL_SECONDS` defaults to 12.
  **Step 2 is that one setting**: `DATASET_SYNC_POLL_SECONDS=3`, no page change (allowed 2 to 60). The page pauses while its tab is
  hidden, polls at once when it comes back, and backs off while the server is unreachable.
- **Banner** (`#dsSyncBanner`). Shown when a counter of a scope the page watches moved AND someone other than this admin made the
  change ("Ben moved 3 photos to Aloe vera (20 s ago). Refresh / Dismiss"). This admin's own changes never raise it. It never
  reloads by itself, because that would throw away a selection. `DatasetSync.markLoaded()` is called at the start of `refreshAll()`.
  A page that wants it: add a `#...Banner` element, include `dataset-sync.js`, call `DatasetSync.start({ scopes, banner, onRefresh })`.
- **Locks** (`dataset_locks`, lease-based, owner = account; the same admin in two tabs is not blocked):
  - *operation locks*: every route that changes something takes them on the items it touches for the length of the request
    (`photo:<imageId>` for Other plant photos, `plant:<plantId>` for a plant's contributions and training, `pid:<pid>` for folder
    photos, `cluster:`, `species:`, `quarantine:`, `snapshot`). Another admin's lock is a **409 `{ code: 'locked', lockedBy: [...] }`**
    ("Ben is working on 3 of these photos right now"). All or none. These sit ON TOP of the row locks the photo queries already take.
  - *claims* ("Ben is working on this"): `POST /api/dataset/locks { keys, purpose }` marks what the open page has selected (folder
    explorer, Other plant inbox), renewed every third of `claimLockSeconds` (90) while the tab is visible, released by
    `POST /api/dataset/locks/release` (also `sendBeacon` on close). Other admins see a marker on those photos and the server refuses
    their changes to them. A claim lapses on its own; a swept marker moves the `locks` counter so pages drop it.
  - *species locks* (Folders view): inside a species folder an admin presses "Lock <species>" (`POST /api/dataset/locks/species { label }`).
    The lock key is `lbl:<name>-<hash>` (`keys.label`, case and spacing ignored) and covers that species in train, val and test at
    once, plus Other plant photos filed under the same name. While it is held, remove, move, group and put-back by anyone else are
    refused with a 409 that names the species ("Ben has locked "Aloe vera"..."); the holder is never blocked by their own lock.
    Moving photos INTO a locked species is the one softer case: the move preview warns ("Ben has locked ... may be working in it") and
    the admin may confirm (an admin who found a leak puts the photo in its correct species); the server requires `confirmLocked: true`
    for it (409 `dest_locked` otherwise) and a confirmed move does not take or release the holder's lock. Two admins on different species do not touch each other. No priority and no override, superadmin
    included. It is a claim row (`kind = 'claim'`, purpose `species`) with a longer lease: `speciesLockSeconds` (300), renewed by the
    open page every third of that (`POST /api/dataset/locks/species/renew`, which only renews what the admin still holds and
    reports `lost`). A closed tab or a crash frees it within the lease; a page with no mouse or keyboard for `speciesIdleMinutes`
    (20) stops renewing; a reload keeps it (`releaseAll` skips `lbl:` keys and the next page adopts its own species locks).
    `speciesLockMax` (5) caps what one admin holds. The server finds the species of a photo through the ML service
    (`POST /dataset/labels`), validates the name against `/dataset/destinations`, and gives the page the keys (`spKey`, `labelKey`)
    so the page never builds one. Env: `DATASET_SPECIES_LOCK_SECONDS`, `DATASET_SPECIES_IDLE_MINUTES`, `DATASET_SPECIES_LOCK_MAX`.
    Not covered: adding a part folder to a locked species, and "Keep all" (still locks the card only).
  - *Resume where I was* (page only, no server): `plantellectDatasetResume` in localStorage holds the view, the folder path and page,
    the duplicate-card and promotion filters/pages and the scroll position. Every click or scroll rewrites it (so an hour without any
    activity expires it); nothing is written on close. After a refresh within the hour the page reopens there; after an hour, or if
    the saved folder no longer exists, it starts from the top. A link with a #section wins over it.
  - If the lock tables are unavailable an operation runs unlocked (one warning); only a real conflict stops it.
- **Audit tags in the Folders view.** `ml/app/dataset_tools/admin_ops.py` `issue_map()` turns the last audit report into a tag per
  photo (not for sets already reviewed): `leak` (LEAK, SIMILAR_LEAK), `duplicate` (REDUNDANT), `clash` (CROSS_CLASS, the same photo
  under two classes). `folder()` returns them as `photos[].issues` and counts them per folder as `folders[].flagged`; the page shows
  "Leakage" / "Duplicate" / "Label clash" on the photo and a count on the folder tile. A photo moved since the audit has a new pid and
  loses its tag until the next audit.
- **Not covered, on purpose.** An audit that FINISHES is still noticed by the page's own status check (20 s, 4 s while running);
  approvals that add new photos are outside the dataset manager; steps 3 (server-sent events) and 4 (patch one row instead of
  reloading) are not built. The log already carries `entityType` / `entityIds` for step 4, and the banner reads counters, so step 3
  only has to push "counter changed" to the same code. The Plants page's Scan Contributions section does not show the banner yet
  (its actions are still protected by the server locks and show the 409 message).
