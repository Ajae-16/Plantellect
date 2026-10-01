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
│   │   ├── admin-dashboard.html  # Protected admin dashboard (role request review)
│   │   ├── admin-user.html       # Users & roles (server-side pagination, suspend/promote)
│   │   ├── admin-plants.html     # Pending plant requests + inventory with detail rows
│   │   └── editor/
│   └── botanist/              # Botanist-specific administration
│       ├── certificates/      # Per-account certificate storage (accountId subfolders)
│       └── plant-images/      # Community-uploaded plant photos (plantId subfolders)
│
├── config/                    # Database connection, settings & schema configurations
│   ├── mongo.js               # MongoDB connection (via Mongoose)
│   ├── mysql.js               # MySQL pool + all query helpers (users, plants, requests, public reads)
│   ├── ids.js                 # Primary key generation: prefix registry, atomic nextId/nextKey/insertRow
│   ├── settings.js            # Centralized settings (timezone, certificates, plantImages, pagination, terms, sessions)
│   ├── upload.js              # Shared multer factories (certificate + plant image uploaders)
│   ├── seed.cjs               # Full schema + minimal seed: roles, permissions, plant types, root account
│   ├── testingdb.cjs          # Optional demo data (npm run seed:test): botanists, plants, photos, review queue
│   └── reset.cjs              # Destructive drop script (npm run db:reset, asks before dropping)
│
├── middleware/                # Custom Express route middleware
│   └── authMiddleware.js      # requireAuth, requireRole, requirePermission, session refresh + status cut-off
│
├── mongoose-schemas/            # Mongoose schemas for MongoDB collections
│   └── Authlog.js               # Mongoose schema for auth/audit logging + logAuthEvent helper
│
├── routes/                    # Express route handlers / API controllers
│   ├── admin.js               # Admin HTML pages + /admin/api/* JSON (users, plants, requests, ml coverage)
│   ├── auth.js                # Public auth: register (consent + certificate), login, logout, me
│   ├── plants.js              # Public plant reads + image serving, and botanist submissions
│   ├── botanists.js           # Public botanist profile
│   ├── role-requests.js       # Role request approve/deny + certificate download
│   └── ml.js                  # ML inference proxy; attaches plantId to predictions
│
├── scripts/                   # Maintenance and verification tooling
│   ├── verify-db.cjs          # npm run verify:db — schema/permission/key-format assertions
│   ├── check-scripts.cjs      # npm run verify:scripts — script-order globals + inline block syntax
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
    │   │   ├── admin-plants.css   # Admin plant inventory styles
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
    │       ├── capture-plant.css  # Plant capture/submission styles
    │       └── library.css        # Unified library page styles (container, sidebar, slider, cards)
    ├── javascript/            # Client-side JavaScript files
    │   ├── home.js              # Server-session-aware nav/routing/restricted UI
    │   ├── auth-script.js       # Auth page logic (tabs, forms, validation, consent payload)
    │   ├── auth.js              # Shared auth helpers (checkAuth, updateNavForAuthState, escapeHtml)
    │   ├── sidebar.js           # Client-side sidebar renderer with sessionStorage cache
    │   ├── nav-toggle.js        # Hamburger toggle for the library sidebar drawer
    │   ├── admin-sidebar.js     # Admin sidebar, drawer, and notification badges (loadNavBadges)
    │   ├── library-script.js    # Library: server-side search, card rendering, pagination
    │   ├── plant-profile.js     # Plant profile page (renders GET /api/plants/:plantId)
    │   ├── botanist-profile.js  # Botanist profile page (renders GET /api/botanists/:accountId)
    │   ├── profile-script.js    # Profile page logic (fetch /api/auth/me, render user info)
    │   ├── logout.js            # Logout confirmation modal, API call, sessionStorage cleanup
    │   ├── ml-client.js         # Frontend ML prediction helper (predictPlant, getModelInfo)
    │   └── scan.js              # Scan modal UI (upload, camera capture, prediction links)
    ├── resource/              # Images and media assets
    ├── about.html             # Public About page
    ├── auth.html              # Combined login/signup page (hash routing: #login, #register)
    ├── forgot-pass.html       # Password reset (NOT implemented — see Out of Scope)
    ├── home.html              # Main public homepage
    ├── library.html           # Unified plant library page (server-driven grid + pagination)
    ├── profile.html           # Public Profile page (username, email, roles from /api/auth/me)
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

**Never store an uploaded file under a client-supplied filename.** `config/upload.js` writes a fresh UUID to disk and keeps the original name for display only; reads resolve from the database row, never from request input.

### Database

- `config/seed.cjs` owns the entire schema and creates it on first boot. It is a no-op once `roles` has rows.
- The seed is deliberately **minimal**: roles, permissions, the three plant types, and one root account (`superadmin` / `plantpassword`). Plant types count as essential because the botanist submission form and the plant type filter both read from that table.
- `npm run seed:test` (`config/testingdb.cjs`) adds optional demo data — botanists, users, plants, photos and a populated review queue. It is for local demos only, and it refuses to run twice.
- `npm run db:reset` drops everything (confirmation required), then `npm start` recreates it.
- `npm run verify:db` asserts key format, column naming, foreign key types, the permission matrix, and the table shapes.
- **A minimal install has an empty public library** until demo data is added or real botanists contribute. That is expected, not a bug.

### Primary Keys

Keys are `<short-prefix>_<exactly 6 digits>` — `acc_000001`, `pimg_000042`. The prefix is a short, recognisable abbreviation of the table's own name; the registry lives in `config/ids.js` and is shared by the seed and the insert helpers.

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
- `plant_contributors` is the many-to-many join. `contributor` renders as "Recorded By", `reviewer` as "Reviewed By".
- Pending submissions live in `approval_requests.payload` only — no orphan rows exist until an admin approves.
- A `plant_addition` whose `scientificName` already exists is not an error: at approval it is attached to the existing plant and the request records a note.
- Approving the first description or image for a plant makes it primary. The approver is always recorded as a `reviewer`.
- A plant is publicly visible only while it has an approved primary description; the filter lives in SQL, not JavaScript.

### Environment Security

Keep `.env` strictly at the project root and ensure it remains listed in `.gitignore` so secrets are never pushed to repository commits.
