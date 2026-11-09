# Sahale Fitness

**Status:** v0.3.1, running in production for one owner. No new features are planned.

A single-owner, set-by-set workout logger with a rest timer. You keep a training block of reusable
workouts, start one when you get to the gym, log what you actually lifted, and finish it into
permanent history. The next time round, each exercise shows what you did last time.

It is a Fastify + SQLite server with a React UI, built to run on a home server and be used from a
phone over a private network. There are no accounts: one person owns the data, and nothing is
reachable from the public internet.

## Run it

Requires Node 22+ (`.nvmrc` pins 24) and npm 11+.

```bash
nvm use
npm ci
cp .env.example .env # optional: port 4311; data goes to .data/dev either way
npm run dev          # runtime on 127.0.0.1:4310 + UI on http://localhost:5173
```

Open <http://localhost:5173>. The first time, Fitness is empty: set a goal, create a block and its
workouts, or press **Load demo data** to try it with a made-up history.

Single-process alternative (built UI served by the runtime):

```bash
npm run build && npm start      # http://127.0.0.1:4310
```

`package.json` carries an npm `allowScripts` policy: esbuild's postinstall is allowed, and
better-sqlite3's source build is denied because its bundled prebuilt binary is used (no compiler
needed). An older npm ignores the policy, and a missing `make` can then fail the install.

Other scripts: `npm test`, `npm run typecheck`, `npm run lint`, `npm run server` (runtime only),
`npm run db -- <command>` (see *Backups and reset*), `npm run db:generate`.

## The Fitness workflow

```
block ──▶ reusable workouts in order ──▶ Start workout ──▶ live session ──▶ Finish ──▶ history
              (Upper A, Lower A, …)        (any day)     (log each set)              │
                     ▲                                                               │
                     └────────────── "last time" for the next session ◀──────────────┘
```

1. **Program**: create a block (name, phase, weeks, intent, progression scheme), then its workouts
   with **New workout**. A workout has a name, an optional focus ("Squat / Quads") and ordered
   exercises, each with sets, a rep **range** (5–8; equal ends show as one number), an optional
   target RPE, load and note. There is no date field. Reorder with the arrows, duplicate with the
   copy icon, open a workout's name to see its prescription and last performance.
2. **Exercises**: every exercise picker has **+ Create exercise** (name, movement family, equipment,
   notes). Your exercises are marked *custom* and work everywhere the built-in ones do.
3. **When you get to the gym**, open the app. The overview shows the live workout, else today's
   planned one, else the **next workout** in the block's order (the one after the last workout you
   did). **Start workout** on it, or **Choose another** on Today and start any saved workout.
4. **Log as you go.** Each exercise shows its prescription and *Last time*. Type the actual load,
   reps and (optionally) RPE per set and tick it; tap the set number for a set note (or the
   speech-bubble icon on a wide screen). Faint numbers are suggestions (your previous set, else last
   time); ticking a set with an empty field takes the suggestion. Ticking a set starts your **rest**
   (see below). Add or remove sets and exercises freely. Every change saves within a moment (the bar
   shows *All changes saved*), and a pending change is flushed if you close the page.
5. **Finish workout** whenever you're done. Nothing has to be complete: the review says what will be
   saved, offers to include sets with reps typed but not ticked, and drops empty sets. The session
   moves to History in one transaction. **Discard** throws a live workout away instead.
6. **History** shows each session's prescription next to what you actually did. Editing a workout
   later never changes a past session. Start the same workout again and *Last time* shows these sets.

**Planning is optional.** **Plan** on a workout card puts it on a date ("Lower A, Oct 8"), and it
shows on the overview and Today that day. Plans can be moved or cleared at any time without touching
the workout. Starting a workout within a week of its plan, early or late, marks the plan done. A date
you miss shows as *not done — nothing logged* and never creates history; the workout is still there
to start whenever you like. **Edit day** gives one planned day its own prescription without changing
the reusable workout.

Only one workout can be live at a time; while one is, every Start button reads **Resume workout**.

### Rest timer

Ticking a set done starts a rest for that exercise. On a phone it is pinned to the bottom of the
screen under your thumb; on a wide screen it is a row in the live bar above the logger. **−15 / +15**
change this rest, **Pause** holds it, **Skip** ends it. When it runs out it turns green and counts the
time over until you tick the next set or press **Done**.

- **Length per exercise**, used in every workout: the timer chip next to each exercise's prescription
  (also *Rest between sets* in the exercise editor). The default is 3:00 for a main lift, 2:00 for
  other squat / hinge / press / pull movements and 1:30 for the rest; *No rest timer* turns it off for
  that exercise.
- **It follows the set.** Ticking the next set replaces the rest; un-ticking or deleting the set that
  started it (or removing its exercise) cancels it; the last set of the workout starts none; finishing
  or discarding the workout ends it. Editing a finished workout never starts one, and rest never
  changes what you logged.
- **It is a deadline, not a counter.** The runtime stores when the rest ends on the live session; the
  page shows *deadline − now*. Lock the phone, switch apps, reload, reopen the Home Screen app or
  restart the runtime, and the time is right the moment the page shows.
- **It can't alert you while the app isn't on screen.** With the phone locked or the app in the
  background nothing runs, so there is no sound, vibration or notification when the rest ends: you see
  where it stands when you look. On screen, Android browsers vibrate; iOS Safari can't.

## State and storage

Stored in SQLite: goals and lift targets, training blocks, **workout templates** (reusable, ordered
within a block, no date), **plans** (an optional date overlay on a template, or a one-off day with its
own prescription), **sessions** (live or completed, with every set), the exercise library (built-in
and yours) and notes.

- **Prescriptions are structured.** `sets`, `rep_min`, `rep_max`, target RPE, target load and a note
  are separate columns (with a `rep_min ≤ rep_max` check). Nothing is parsed out of text.
- **Prescription and performance are separate.** Starting a workout writes the session at once with a
  snapshot of each exercise's prescription and empty set rows. What you log (load, reps, RPE, note,
  done) goes in the set rows.
- **Live logging survives everything.** The live session is in the database from the moment you press
  Start, and typed values are saved as you go. Refresh, close the browser or restart the runtime and it
  is still there. A partial unique index enforces one live session.
- **Rest is part of the live session.** The set it follows, its length, and when it ends (or the time
  left while paused) are columns on the session row, written in the same transaction as the tick. Each
  exercise's rest length is a column on the exercise.
- **History is immutable to the program.** Finishing never edits the template, and editing or deleting
  a template never rewrites a completed session (it keeps its own name and prescription snapshot).
- **Edits are version-checked.** Templates, plans and sessions carry a `version`; an edit made against
  an older one is refused with `409 version_conflict` rather than silently overwriting.
- **Demo data is marked.** Rows loaded by *Load demo data* have `origin = demo` and show a "demo" tag.
  *Clear demo data* removes exactly those rows; anything you logged or edited is yours and stays. The
  exercise library is built in (`origin = library`) and never cleared.
- Times are stored as UTC instants; planned workouts live on calendar dates in your timezone (the UI
  sends it with every request).

Everything lives under one data folder, set with `SAHALE_DATA_DIR`. When it is unset, development uses
`.data/dev` in the checkout (gitignored) and production refuses to start. Outside production the runtime
also refuses data folders known to hold real records unless `SAHALE_ALLOW_DATA_DIR` names the exact
path. The Runtime page shows the paths in use.

| Path | Contents |
| --- | --- |
| `sahale.db` (+ `-wal`, `-shm`) | All Fitness data |
| `backups/` | Automatic pre-migration backups, manual and pre-reset backups (UTC timestamps) |

## Migrations

Migrations are SQL files in `server/db/migrations`, generated from `server/db/schema.ts`
(`npm run db:generate`), and applied by the runtime at startup:

- applied migrations are checked by hash: an edited or unknown (newer) migration stops startup with an
  explanation rather than guessing;
- before applying anything to an existing database, a full backup is written to `backups/`;
- all pending migrations run in **one transaction** with foreign keys switched off at the connection
  level (so table rebuilds can't cascade-delete rows), and `foreign_key_check` must pass before commit;
- if a migration fails, nothing is applied, the file is left as it was, and the runtime starts in a
  degraded mode that reports *migration failed* instead of serving Fitness.

**Orphaned tables.** This app began as a larger prototype. `0000_init` and `0003_career_applications`
still create its tables (`career_applications`, `career_status_changes`, `conversations`, `messages`,
`model_runs`, `proposals`, `committed_actions`), and they stay in existing databases, unused: the schema
no longer defines them and no code reads them. The migrations can't change, because an applied migration
is hash-checked, and releases refuse new migrations until there is a migration path for production.
Until then, `npm run db:generate` emits `DROP TABLE` for all of them in whatever migration it writes next,
so check the generated file before keeping it.

## Backups and reset

```bash
npm run db -- status          # schema state and row counts
npm run db -- backup          # consistent copy into backups/ (safe while running)
npm run db -- demo:load       # add demo data;  demo:clear removes only demo rows
npm run db -- reset --yes     # back up, then delete the database (stop the server first)
```

The Runtime page also has **Back up now** and **Load / Clear demo data**. To restore, stop the server
and copy a backup over `sahale.db` (delete `sahale.db-wal`/`-shm` first).

## Phone access

The runtime stays on 127.0.0.1. **Tailscale Serve** on the same machine terminates HTTPS at
`https://<host>.<tailnet>.ts.net` and proxies to it, and the runtime answers that one hostname only when
Serve vouches the request comes from **your** tailnet login. Nothing listens on the LAN, and Funnel
(public internet) is never used: Funnel traffic is refused even if someone turns it on.

| Request | Result |
| --- | --- |
| Host `localhost` / `127.0.0.1` (this machine) | Served; no identity involved |
| Host = the `SAHALE_PUBLIC_ORIGIN` host, `Tailscale-User-Login` = `SAHALE_OWNER_LOGIN` | Pages and API. Writes also need `Origin: SAHALE_PUBLIC_ORIGIN` and the UI header |
| Same host, no identity, another login, a tagged device, or Funnel | `403 forbidden_identity`, pages included |
| Any other Host (a tailnet IP, another name) | `403 forbidden_host` |

Startup refuses an origin that isn't a single `https://` DNS name, an origin without an owner login (or
the reverse), a non-ASCII login, and any `SAHALE_HOST` other than loopback.

Why the header can be trusted: Serve deletes client-sent `Tailscale-User-*` and
`Tailscale-Funnel-Request` headers, then sets `Tailscale-User-Login` only for an identified, untagged
peer and marks Funnel traffic instead (tailscale `ipn/ipnlocal/serve.go`). Serve also forwards the
browser's `Host` unchanged. Any process on the machine can reach 127.0.0.1 and set the header itself:
the same trust boundary as the database file. `x-sahale-client` is a cross-site guard, not
authentication.

On phones the rail becomes a drawer (☰ in the top bar), form fields are 16px so Safari doesn't zoom, and
the live logger is one row per set (number · load × reps · RPE · ✓, all at least 44 px tall) with the
rest timer docked at the bottom above the home indicator; it steps aside while the keyboard is up.

To try it from a laptop:

```bash
npm run build
SAHALE_DATA_DIR=<data folder> SAHALE_PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net \
SAHALE_OWNER_LOGIN=<you@example.com> npm start
tailscale serve --bg http://127.0.0.1:4310     # in another terminal; never `tailscale funnel`
```

`tailscale whois <phone's 100.x address>` shows your login under *User*. Then open
`https://<host>.<tailnet>.ts.net/today` on the phone and use **Add to Home Screen**. `npm start` serves
only the asset files that existed when it started, so restart it after every build (a stale one serves
a blank page).

- `forbidden_identity` on the phone: `SAHALE_OWNER_LOGIN` doesn't match `tailscale whois`.
- `forbidden_host`: the address used isn't `SAHALE_PUBLIC_ORIGIN`.
- A 502 from Serve: the runtime isn't running.

## Always-on host

To run it on a small Linux server (systemd, Tailscale Serve on its own port, nightly snapshots for the
host's backups), follow [`deploy/README.md`](deploy/README.md). It covers moving a database across and
rolling back. The app runs from `/opt/sahale` with its data in `/var/lib/sahale`, and changes reach it
only through `deploy/release <tag>` and `deploy/rollback <tag>`; `bash deploy/release.test.sh` rehearses
both against a fake host.

## Tests

`npm test` uses a throwaway data folder for every test and covers:

- migrations: fresh init, idempotence, pre-migration backup, rollback on failure, no cascade loss during
  table rebuilds, edited or newer migrations refused, old data carried forward without inventing
  templates, and an additive upgrade with a workout live;
- reusable workouts: no date, rep ranges as structured data, create / edit / duplicate / reorder, custom
  exercises usable everywhere;
- live sessions: durable from Start, survive a restart, actual sets kept apart from the prescription,
  Finish is atomic and never needs every set or edits the template, history unchanged by later template
  edits;
- optional plans (set / move / clear, a missed date logs nothing, an early start fulfils the plan), "last
  time" and next-in-sequence, and demo versus owner data;
- the rest timer: started by a completed set as a stored deadline, per-exercise lengths and *off*, skip /
  pause / resume / ±time, cancelled with its set, none after the last set, cleared by Finish, never
  touching logged sets or the session version, surviving a restart;
- request guards: loopback hosts, the private origin and owner identity, origins, the UI header, and
  refusing real data folders outside production.

## Known limitations

- Single owner, no authentication beyond the guards above. The runtime only listens on 127.0.0.1, so a
  phone reaches it only through Tailscale Serve as the owner.
- No offline mode: a save without signal fails visibly (*Not saved — runtime unreachable*) and isn't
  retried by itself.
- Loads are in pounds; there is no kg setting. "Last time" is simple and per exercise: its sets from the
  most recent session of the same workout, else from the most recent session that included it. There
  are no progression suggestions or supersets, and no warm-up sets: every ticked set starts a rest.
- The rest timer is only visible, never heard, while the app is in the background or the phone is
  locked, and the app doesn't keep the screen awake. It relies on the phone's and the host's clocks
  agreeing (both set by network time).
- There is no bodyweight log: a goal's bodyweight target is stored but nothing measures against it.
