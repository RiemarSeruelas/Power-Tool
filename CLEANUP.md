# Safe cleanup from the mixed Confirmation repository

The active application is Power Tool. It starts from `server/index.js` and uses
the `server/`, `scripts/`, `nginx/`, and `src/` folders.

## Remove these tracked legacy files

These belong to the older Confirmation/Docling application and are not loaded
by the current `package.json`, Dockerfile, Compose file, or imports:

```text
.env.docling-additions
.env.network-example
.env.proof-example
Caddyfile
Dockerfile.docling
Docling Trial/
README.txt
checkDb.js
confirmationproof.sql
db.js
dbCheck.js
docling_service.py
env.example
makeDb.js
schema.sql
server.js
stash/
trial.py
```

`node_modules/` and `dist/` are generated and may also be deleted. Recreate them
with `npm ci` and `npm run build`.

The `logs/` folder is no longer required. Application visit/audit records are
stored in PostgreSQL under `app."PowerTool-logs"`, while ordinary Nginx
diagnostics are available through `docker compose logs nginx`. Keep
`server/data/db.json` as an offline migration backup until the PostgreSQL import
has been verified; never commit it.

## Environment files

Keep:

- `.env` — private runtime values; local/server only.
- `.env.example` — sanitized variable names and placeholders; safe for Git.

Because `.env` was previously committed, ignoring it is not enough. Keep the
local file but remove it from Git tracking:

```powershell
git rm --cached .env
```

Then remove the legacy files listed above, stage, inspect, and commit:

```powershell
git add .
git status
git commit -m "Clean legacy files and secure configuration"
git push
```

Before committing, `git status` must not show `.env`, `server/data/db.json`,
`node_modules/`, or `dist/` as added files.

## Required security action

Deleting `.env` from the current branch does not erase it from old commits.
Treat every credential that appeared in the public repository as exposed.
Rotate it, or preferably create a dedicated least-privilege PostgreSQL account
for this application, then update the private `.env` files of every affected
deployment.
