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
│   │   ├── admin-dashboard.html  # Protected admin dashboard (role request review,
│   │   │                        #   YOUR ACCESS card, read-only species-gap card,
│   │   │                        #   and statistics cards loaded from /admin/api/reporting/stats)
│   │   ├── admin-user.html       # Users & roles (server-side pagination, suspend/promote)
│   │   ├── admin-plants.html     # Pending plant requests + inventory with detail rows,
│   │   │                        #   the discovery-report audit queue (#discoveryQueue)
│   │   └── admin-settings.html   # Centralized admin settings (ML model, approval modes, quotas)
│   └── botanist/              # Botanist-specific administration
│       ├── certificates/      # Per-account certificate storage (accountId subfolders)
│       └── plant-images/      # Community photos, one folder per review state:
│           ├── plants/{pending,approved,denied}/<requestId|plantId>/
│           └── discoveries/{pending,approved,denied}/<requestId>/
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
│   ├── registration-mysql.js  # Registration, consent and role request persistence
│   ├── user-mysql.js          # User listing, status and role changes
│   ├── request-mysql.js       # Review queues and request decisions
│   ├── plant-mysql.js         # Plant reads, image access and approval writes
│   ├── public-mysql.js        # Public plant/botanist reads and ML coverage
│   ├── record-mysql.js        # Plant validation and botanist submissions
│   ├── submission-mysql.js    # NOT REQUIRED BY ANYTHING: an older copy of record-mysql.js. Delete it.
│   ├── plant-manage-mysql.js  # Change requests (plant_change), split into two independent scopes, each its
│   │                          #   own request row with its own reason: 'base' (commonName, scientificName,
│   │                          #   the plant's own type, its own taxonomy; one pending per plant) and
│   │                          #   'description' (ONE botanist's own plant_description + plant_parts, named by
│   │                          #   payload.descriptionId; one pending per description). Neither scope can write
│   │                          #   into the other. getPlantEditable(plantId, accountId) returns only the caller's
│   │                          #   own descriptions; applyPlantChange runs in approvePlantRequest's transaction
│   ├── discovery-mysql.js     # Discovery reports, votes and image access
│   ├── scan-mysql.js          # Scan quota accounting
│   ├── setting-mysql.js       # System settings and upload limits
│   ├── approval-mysql.js      # Manual plant approval/denial transactions
│   ├── auto-approval-mysql.js # Automatic approval rules and first-submission rail
│   ├── certificate-mysql.js   # Certificate records and removal
│   ├── shared-mysql.js        # Shared query constants/helpers
│   ├── ids.js                 # Primary key generation: prefix registry, atomic nextId/nextKey/insertRow
│   ├── settings.js            # Centralized settings (timezone, certificates, plantImages,
│   │                          #   pagination, terms, sessions, ml quotas + retention)
│   ├── limits.js              # Database-backed setting resolution and bounds
│   ├── ml-confidence.js       # ML confidence settings and validation
│   ├── upload.js              # Shared multer factories (certificate + plant image uploaders)
│   │                          #   and handleUploadError() -> 400 with the real limit
│   ├── approval-mode.js        # Manual/automatic approval switches (3 rbac_meta keys, all '0')
│   │                          #   + the system reviewer identity and its audit vocabulary.
│   │                          #   Takes an executor, never imports mysql.js: the mode is read
│   │                          #   INSIDE the transaction that decides on it.
│   ├── seed.cjs               # Full schema + minimal seed: roles, permissions, plant types,
│   │                          #   root account, the inactive system actor, the rbac_meta switches,
│   │                          #   and 5 read-only reporting views (vw_active_users, vw_active_botanists,
│   │                          #   vw_recent_plants, vw_total_plants, vw_pending_requests)
│   ├── migrate.cjs            # npm run db:migrate — idempotent, non-destructive schema migration.
│   │                          #   Run it TWICE in a row; the 2nd run exercises every guard's
│   │                          #   already-applied branch.
│   ├── migrate-record.cjs     # Targeted plant-record schema migration
│   ├── prune-usage.cjs        # npm run db:prune:usage — manual, idempotent retention prune for
│   │                          #   ml_scan_usage rows and Mongo mlscans events
│   ├── testingdb.cjs          # Optional demo data (npm run seed:test): botanists, plants, photos, review queue
│   └── reset.cjs              # Destructive drop script (npm run db:reset, asks before dropping).
│                              #   DROPS TABLES ONLY — clear plant-images/ and certificates/
│                              #   afterwards, or ids restart at plant_000001 and serve the
│                              #   previous database's photos. It prints that instruction.
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
│   │                          #   approval modes, reporting stats: /admin/api/reporting/stats)
│   ├── discoveries.js         # /api/discoveries: the discovery loop. Report filing, botanist
│   │                          #   queue + count, reporter's own view, the owner AND botanist
│   │                          #   photo routes, and claim/resolve/vote/cancel. A separate router
│   │                          #   from plants.js on purpose: a different feature with a different
│   │                          #   permission model, and a claim there would also put /count and
│   │                          #   /images/:imageId behind /:plantId
│   ├── auth.js                # Public auth: register (consent + certificate), login, logout, me
│   ├── plant-changes.js       # GET /api/plants/:plantId/editable, POST /api/plants/:plantId/changes
│   │                          #   (body { base?, description? }: one request per scope sent).
│   │                          #   Mounted BEFORE routes/plants.js in index.js
│   ├── plants.js              # Public plant reads + image serving, owner-scoped image serving,
│   │                          #   botanist submissions, and public recent plants (/api/plants/recent)
│   ├── botanists.js           # Public botanist profile
│   ├── role-requests.js       # Role request approve/deny + certificate download. The decision
│   │                          #   body is decideRoleRequest in mysql.js, shared with auto mode
│   ├── ml.js                  # ML inference proxy; scan_plant gate, bounded upload, quota, logs
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
    │       ├── capture-plant.css  # Scan page (capture-plant.html): upload area, preview, results
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
│   │   ├── admin-topbar.js      # Admin topbar interactions
│   │   ├── admin-plant-images.js # Admin plant image review
│   │   ├── admin-plant-manage.js # Plant detail and management interactions
│   │   ├── plant-changes.js     # Plant change form helpers
    │   │   ├── admin-discoveries.js # The admin discovery-report audit queue on admin-plants.html.
    │   │   │                        #   SELF-INITIALISING: it calls initDiscoveryQueue() itself, so
    │   │   │                        #   no page may call it and no load order is assumed
    │   │   └── admin-user.js        # Admin users page logic
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


## Plant types and badges (per-plant model)

- Every plant OWNS exactly one `plant_types` row (typeName, isMedicinal, isHarmful,
  toxicityLevel, cautionNote). The name is free text and repeats across plants; only
  `typeId` is unique. Editing one plant's type can never touch another plant.
- `GET /api/plants/types` returns the NAMES in use (grouped, most used first) for the
  suggestion list and the library filter: `[{ typeName, label, plantCount }]`.
- A new plant's type row is created when an admin approves (approval-mysql.js), not at
  submission. A change request edits the plant's own row in place (plant-manage-mysql.js).
- One badge per plant: its type name, coloured by toxicityLevel (green none, yellow mild,
  orange moderate, red severe). Tokens: `public/css/core/variables.css` (--badge-*).
  Rules: `public/css/core/badges.css`. Markup + icon list: `public/javascript/badges.js`
  (`PlantBadge.html(name, level)`, `RoleBadge.html(role)`). Icons are glyphs today; set
  `USE_MATERIAL_SYMBOLS = true` there once the Material Symbols font is loaded on a page.
- The caution note belongs to the plant and is shown whether or not it is harmful.


## Rich text (botanist descriptions)

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
  `.contrib-box` (8 colours, then repeats) under "More details from other botanists".

## Admin plant editing, withdraw, dashboard

- `config/admin-plant-edit-mysql.js` + routes in routes/admin.js: `GET /admin/api/plants/:id/edit`,
  `PATCH /admin/api/plants/:id` (base: names, type, taxonomy), `PATCH .../descriptions/:descriptionId`
  (one description + its measurements, `makePrimary`), `POST .../descriptions/:descriptionId/primary`.
- `config/withdraw-mysql.js`: `POST /api/plants/requests/:requestId/withdraw` (submitter only, pending only,
  status becomes 'cancelled', photos rejected and filed under plants/denied/).
- Dashboard: Sign-ins per day (`GET /admin/api/reporting/signins?days=`, from Authlog) and Most scanned plants
  (`/admin/api/ml/usage/top`) replace the species-gap card (`/gaps` endpoint still exists).
