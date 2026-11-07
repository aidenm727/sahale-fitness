# Sahale Fitness

A single-owner, set-by-set workout logger with a rest timer: Fastify + SQLite (`better-sqlite3`, Drizzle) runtime
in `server/`, React 19 + Vite UI in `src/`, types and schemas in `shared/`. Node 22+ (`.nvmrc` pins 24). No accounts.
Part of the owner's personal setup; the app stands alone.

`README.md` is the product and operations reference; `deploy/README.md` covers the always-on host. Code, git and
runtime outrank every document, this file included.

## Commands

```bash
npm ci                # install exactly what package-lock.json says
npm run typecheck     # tsc -b
npm run lint          # eslint .
npm test              # vitest run (tests use a throwaway temp data dir)
npm run build         # tsc -b && vite build
npm run dev           # runtime on 127.0.0.1:4310 + UI on :5173
npm run db:generate   # new migration from server/db/schema.ts
```

Run typecheck, lint and test before saying a change is done. Run one file with
`npx vitest run test/<name>.test.ts`.

## Layout

- `server/`: `app.ts` (hooks, guards), `config.ts`, `routes/` (`runtime`, `fitness`), `fitness/` (service, demo
  data, exercise library), `db/` (schema, migrations), `scripts/db.ts`.
- `src/`: `domains/fitness/` (the pages), `domains/runtime/`, `shell/`, `sahale/` (the route map), `state/`,
  `runtime/api.ts`, `ui/`. `shared/`: schemas and types used by both sides.
- `test/`: one file per area; `test/helpers.ts` builds an app on a temp data dir.
- `deploy/`: systemd units, `sahale-sqlite.py` (online `snapshot` and `check`), host README, and the release
  tooling: `release` / `rollback`, `release-host.sh` + `release-lib.sh` (host), `cp3.sh overnight` (morning backup
  check), `release.test.sh` (fake-host rehearsals).

## Releases

Production changes only through `deploy/release <tag>` and `deploy/rollback <tag>`; never by hand on the host.
They release code only: a tag that adds migrations, isn't a descendant of the deployed commit, or changes a unit
file is refused. Check changes to the tooling with `bash deploy/release.test.sh` (fake host, stubs; no ssh).
`--dry-run` never contacts the host. Running either command for real is the owner's action, not an agent's.

## Invariants (each is enforced in code or tests)

- **Mutating requests** (anything but GET/HEAD under `/api/`) need the `x-sahale-client: 1` header, or they get 403
  `missing_client_header` (`server/app.ts`). It is a cross-site guard, not authentication.
- **Edits are version-checked.** Rows carry a `version`; a stale one is rejected with 409 `version_conflict`, never
  silently overwritten.
- **Migrations** (`server/db/migrations`, generated, hash-verified at startup): never edit an applied migration; an
  edited or newer one stops startup. Tables the schema no longer defines stay in existing databases, and
  `npm run db:generate` emits `DROP TABLE` for them; a new migration must not carry those statements by accident
  (README, *Migrations*).
- **Version** lives in `package.json`, `package-lock.json` (both entries) and the runtime
  (`server/routes/runtime.ts`); `test/version.test.ts` requires them to agree.

## Data safety

- Outside production, an unset `SAHALE_DATA_DIR` is `<repo>/.data/dev`; in production it must be set. A store holds
  `sahale.db` (+ `-wal`, `-shm`) and `backups/`.
- **The owner's real stores, never to be pointed at, opened or migrated by development or tests:**
  `~/.local/share/sahale`, `~/.local/share/sahale-*`, `~/.local/share/aiden-platform`, `/var/lib/sahale*`,
  `~/sahale-release`.
- `loadConfig` refuses those paths outside production unless `SAHALE_ALLOW_DATA_DIR=<exact path>`. Develop on the
  default (`cp .env.example .env`), or a scratch dir: `SAHALE_DATA_DIR=$(mktemp -d) SAHALE_PORT=4311 npm run dev`.
- Copy a database with its `-wal` and `-shm`, with the runtime stopped. Never print or commit credentials, tailnet
  names or tokens. Keep real names and records out of tests and fixtures; demo data is opt-in and marked
  `origin = demo`.

## Authority

Do without asking: read code, edit files in the working tree, run the commands above.
Ask first: `git commit`, `git push`, tags, dependency changes, any migration.
Never: ssh to the host, deploy, or delete branches, worktrees or files.
No AI attribution in commits: no `Co-Authored-By` trailers, session links or "Generated with" lines.
