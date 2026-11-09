# Running Sahale on an always-on Linux host

Sahale on a small Ubuntu server, reached from your phone through Tailscale Serve. No
containers, nothing on the LAN, nothing public. The laptop instructions in the main README
still apply for development.

```
phone ──tailnet──▶ tailscaled Serve :8443 (HTTPS, sets Tailscale-User-Login)
                       └─▶ http://127.0.0.1:4310   sahale.service (user sahale)
                                 └─ /var/lib/sahale/sahale.db
nightly: sahale-snapshot.timer ─▶ /var/lib/sahale/snapshots/sahale-latest.db ─▶ host Restic (local + off-site)
```

| Path | What | Owner |
| --- | --- | --- |
| `/opt/node` → `/opt/node-v24.x.y-linux-x64` | Node, from the official tarball | root |
| `/opt/sahale/app` | This repository at the deployed commit, built | admin user, read-only to `sahale` |
| `/opt/sahale/app-<tag>` | Trees staged or kept by `deploy/release` (the previous release, for rollback) | admin user |
| `/opt/sahale/DEPLOYED`, `releases.log` | What is deployed; one line per release, rollback or swap-back | admin user, 0644 |
| `/etc/sahale/sahale.env` | Public origin + owner login (from `sahale.env.example`) | root, 0644 |
| `/etc/sahale/release.conf` | Release window, Restic units and paths for the release and cp3 (from `release.conf.example`) | root, 0644 |
| `/var/lib/sahale` | Database, automatic backups, snapshots | `sahale`, 0700 |
| `/etc/systemd/system/sahale*.{service,timer}` | Copies of the files in this folder | root |

Serve uses **:8443**, not 443, so it never shadows a reverse proxy (Traefik) that already
answers on :443 at the host's tailnet address. The runtime refuses any Host other than
loopback and the configured origin, so the port is part of the origin.

Placeholders: `<host>.<tailnet>.ts.net` is the server's MagicDNS name, `<you@example.com>`
your Tailscale login, `<admin>` your own account on the server.

---

## 1. Prepare the host (no production data)

```bash
# Node (match the laptop's major version; checksum-verified)
NODE=v24.21.0
cd /tmp && curl -fsSLO https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz \
  && curl -fsSLO https://nodejs.org/dist/$NODE/SHASUMS256.txt \
  && grep " node-$NODE-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
sudo tar -C /opt -xJf node-$NODE-linux-x64.tar.xz && sudo ln -sfn /opt/node-$NODE-linux-x64 /opt/node
/opt/node/bin/node -v

# Service account: no shell, no home, no groups
sudo useradd --system --user-group --home-dir /var/lib/sahale --no-create-home --shell /usr/sbin/nologin sahale

# Code, from the git bundle made on the laptop (copy it over with scp first)
sudo install -d -o <admin> -g <admin> -m 0755 /opt/sahale
git clone --branch <branch> ~/sahale-<commit>.bundle /opt/sahale/app
cd /opt/sahale/app && git log -1 --oneline
PATH=/opt/node/bin:$PATH npm ci && PATH=/opt/node/bin:$PATH npm run build && PATH=/opt/node/bin:$PATH npm test

# Settings and units (installed, not enabled)
sudo install -d -m 0755 /etc/sahale
sudo install -m 0644 deploy/sahale.env.example /etc/sahale/sahale.env && sudoedit /etc/sahale/sahale.env
sudo install -m 0644 deploy/sahale.service deploy/sahale-snapshot.service deploy/sahale-snapshot.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

**Rehearse** under the real unit and its hardening, on scratch data: a runtime drop-in (gone on
reboot) points it at `/var/lib/sahale-rehearsal` and port 4311. Resetting `StateDirectory=` also
resets `StateDirectoryMode=` to systemd's default 0755, so the drop-in sets the mode again.

```bash
sudo install -d -m 0755 /run/systemd/system/sahale.service.d
sudo tee /run/systemd/system/sahale.service.d/rehearsal.conf >/dev/null <<'EOF'
[Service]
Environment=SAHALE_DATA_DIR=/var/lib/sahale-rehearsal
Environment=SAHALE_PORT=4311
StateDirectory=
StateDirectory=sahale-rehearsal
StateDirectoryMode=0700
EOF
sudo systemctl daemon-reload && systemctl show sahale -p StateDirectory -p StateDirectoryMode   # sahale-rehearsal, 0700
sudo systemctl start sahale && sleep 3 && curl -s http://127.0.0.1:4311/api/runtime/health    # {"ok":true,…}
sudo stat -c '%a %U %n' /var/lib/sahale-rehearsal /var/lib/sahale-rehearsal/sahale.db         # 700 sahale, 600 sahale
sudo systemctl stop sahale
sudo rm /run/systemd/system/sahale.service.d/rehearsal.conf && sudo systemctl daemon-reload
sudo rm -rf /var/lib/sahale-rehearsal
systemctl show sahale -p StateDirectory -p StateDirectoryMode   # back to sahale, 0700
```

## 2. Move an existing database onto the host (moves the production database)

This moves an existing `sahale.db` from another machine (the *source*) onto the host.

The rule throughout: **exactly one** machine has `sahale.db` under that name, a running
runtime and an active Serve. `<source data dir>` below is the folder the source's runtime used
(its `SAHALE_DATA_DIR`); `<server>` is the host as `ssh`/`scp` know it.

On the **source**:

1. No workout in progress (or finish it). Stop every Sahale process (`npm start`,
   `npm run dev`, a service); check with `ps -eo pid,args | grep -E 'tsx|server/index'`, that no
   process has the database open, and that `<source data dir>/sahale.db-wal` is absent or 0 bytes.
   A read-only open (`sahale-sqlite.py snapshot` or `check` on a stopped WAL database) leaves an
   empty `-wal` and a `-shm` behind; those are harmless. A non-empty `-wal` holds committed data
   not yet in `sahale.db`: start and cleanly stop Sahale once before copying anything.
2. Turn off the source's Serve for Sahale (`tailscale serve status` shows it; `tailscale serve reset`
   if it is the only one), so the phone can no longer reach the source.
3. Copy and check, from a checkout of this repository:
   ```bash
   python3 deploy/sahale-sqlite.py snapshot <source data dir>/sahale.db ~/sahale-move.db
   python3 deploy/sahale-sqlite.py check ~/sahale-move.db | tee ~/sahale-move.check
   sha256sum ~/sahale-move.db
   ```
   `snapshot` writes one self-contained file (nothing pending in a `-wal`). Expect
   `integrity ok`, `active workouts 0`, and your recent sessions listed. Keep a second copy of
   `sahale-move.db` on another disk until step 8 passes.
4. `scp ~/sahale-move.db ~/sahale-move.check <server>:` and compare `sha256sum` there.
   Copy nothing else: never `backups/`, `-wal` or `-shm`.

On the **server**:

5. Install it and start:
   ```bash
   sudo install -d -o sahale -g sahale -m 0700 /var/lib/sahale
   sudo install -o sahale -g sahale -m 0600 ~/sahale-move.db /var/lib/sahale/sahale.db
   sudo stat -c '%a %U %n' /var/lib/sahale /var/lib/sahale/sahale.db   # 700 sahale, 600 sahale
   sudo ls -la /var/lib/sahale                     # no stale -wal/-shm
   sudo systemctl enable --now sahale
   journalctl -u sahale -n 20 --no-pager           # database ready, no "applied …"; private https://…:8443
   ```
6. Compare with the source's report (a snapshot taken now, so the numbers come from a
   consistent read):
   ```bash
   sudo -u sahale python3 /opt/sahale/app/deploy/sahale-sqlite.py snapshot /var/lib/sahale/sahale.db /var/lib/sahale/verify.db
   sudo -u sahale python3 /opt/sahale/app/deploy/sahale-sqlite.py check /var/lib/sahale/verify.db | diff ~/sahale-move.check - && echo identical
   sudo rm /var/lib/sahale/verify.db
   ```
   Go on only if they are identical.
7. Open the door: `sudo tailscale serve --bg --https=8443 http://127.0.0.1:4310`, then
   `tailscale serve status`. Check that the services behind the existing reverse proxy still load.
8. Phone: `https://<host>.<tailnet>.ts.net:8443/history` shows your latest
   workout and its sets. Add it to the Home Screen and remove any icon for the old address. (The
   tailnet policy must let the phone reach the server on 8443.)

Back on the **source**, retire the old copy so it can't be written again (with the runtime still
stopped):

```bash
mv <source data dir>/sahale.db <source data dir>/sahale.db.moved-$(date +%Y%m%d)
chmod 0400 <source data dir>/sahale.db.moved-*
```

If the source is also your development machine, develop with plain `npm run dev`: with
`SAHALE_DATA_DIR` unset it uses `.data/dev` in the checkout, and outside production the runtime
refuses the known real stores unless `SAHALE_ALLOW_DATA_DIR` names the exact path.

**Rollback.** Before anything new is logged on the server: `sudo tailscale serve --https=8443 off`,
`sudo systemctl disable --now sahale`, rename the source's file back, start the source and its
Serve. After something new was logged: do the same, but first move the server's data back
the way it came (steps 1, 3 and 4 with the machines reversed), then rename the server's copy aside.

## 3. Backups, then prove the restore

Deployment isn't finished until an **off-site** copy has been restored and checked.

```bash
sudo systemctl enable --now sahale-snapshot.timer
sudo systemctl start sahale-snapshot.service && journalctl -u sahale-snapshot -n 5 --no-pager
```

Add `/var/lib/sahale/snapshots` to the path list of every host backup job (local and
off-site Restic). Do this only once the snapshot exists: a missing path makes Restic exit
non-zero. Run the jobs once by hand, then restore from the **off-site** repository into a
scratch directory, using the same repository and credentials the job uses:

```bash
restic -r <off-site repo> snapshots --path /var/lib/sahale/snapshots
restic -r <off-site repo> restore latest --include /var/lib/sahale/snapshots --target /root/sahale-restore-test
python3 /opt/sahale/app/deploy/sahale-sqlite.py check /root/sahale-restore-test/var/lib/sahale/snapshots/sahale-latest.db
rm -rf /root/sahale-restore-test
```

`integrity ok` with the expected sessions is the pass. Repeat against the local repository.

**Restoring for real**: `sudo systemctl stop sahale`, move `sahale.db*` aside, install the
restored file as in step 5, start.

## 4. Releases: `deploy/release` and `deploy/rollback`

Production changes only through these two commands, run from the laptop checkout. Never update
`/opt/sahale/app` by hand. They release **code only**: the tag's `server/db/migrations` must be identical to
the deployed tree's.

**One-time setup.**

- Laptop: `cp deploy/release.env.example ~/.config/sahale/release.env` and fill in the ssh alias and the admin
  account (outside git).
- Host: `/etc/sahale/release.conf` (root:root 0644) from `deploy/release.conf.example`: the nightly window,
  the Restic units, scripts, repositories and stamps, and the cp3 log folders. Placeholders are refused.

**Each release** (outside 02:30–04:30):

1. This morning's `cp3.sh overnight` passed (Day to day, below).
2. The version bump is committed (`package.json`, both lockfile entries, `server/routes/runtime.ts`), CI is
   green on that exact commit, and the annotated tag is pushed: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
3. `deploy/release vX.Y.Z --dry-run`: every laptop check, the kit built locally, and every command the host would
   run, printed. Nothing is sent. Any `REFUSE` line names a blocker (exit status 1).
4. `deploy/release vX.Y.Z`: sudo asks for the password once.

What a run does, stopping at the first failure:

| Step | Where | What |
| --- | --- | --- |
| Preflight | laptop | clean tree; annotated tag, same object and commit on `origin`; `gh run list --workflow CI` green on the commit; version in all four places equals the tag |
| Read | host, no sudo | the deployed commit (`DEPLOYED`, else `git rev-parse`); on the laptop: it is an ancestor of the tag, migrations identical, unit files identical |
| Transfer | laptop → host | `git bundle` of the tag + the tag's `release-host.sh`, `release-lib.sh`, `sahale-sqlite.py` and `SHA256SUMS` into `~/sahale-release/<tag>/`, verified there |
| Host preflight | host, sudo | kit = the SHA256SUMS the laptop sent; deployed tree clean; service active, health ready, version as deployed; Serve and env; window and jobs idle; today's cp3 passed; ancestry and migrations again from the bundle; live database integrity, migrations = the tag's, no workout in progress; installed units = the tag's; Node = the tag's `.nvmrc` |
| Stage | host, as admin | `git clone` the bundle into `/opt/sahale/app-<tag>` beside production, `npm ci`, `npm run build`, `npm test`, clean tree |
| Snapshot | host, as `sahale` | `sahale-sqlite.py snapshot` (online) into `/var/lib/sahale/backups/sahale-<UTC>-before-<tag>.db`, then `check`; sha256 recorded |
| Switch | host | stop; the stopped database equals the snapshot; `app` → `app-<previous tag or commit>`, `app-<tag>` → `app`; start; `database   ready` with nothing applied; version; report and content fingerprint equal to the stopped database; owner-only matrix; Serve, units, drop-ins and timer unchanged; no failed unit |
| Record | host + laptop | `/opt/sahale/DEPLOYED` (0644) and one line in `/opt/sahale/releases.log`; the laptop keeps a copy in `~/.local/state/sahale/releases.log` |

**Any failed check after the switch swaps back on its own**: stop, the new tree aside as
`app-<tag>-failed-<UTC>`, the previous tree back, start, version and data as before, a `swapped-back` line in
`releases.log`. `DEPLOYED` is unchanged. The output ends `SWAPPED BACK: … is running again`.

**Refused, never attempted:** a tag that adds or changes migrations, a tag the deployed commit isn't an
ancestor of (e.g. a sibling line that lacks deployed fixes: merge first), a tag that changes a unit file (install
units by hand as in §1, separately), CI not green, a version mismatch, an unpushed tag, and passwordless sudo.

**Rollback**: `deploy/rollback vX.Y.Z [--dry-run]` switches back to an earlier tag's tree (the one the release
kept, else re-staged from a bundle), with the same preflight, snapshot, switch, swap-back and record. It runs only
when the live database's migrations equal that tag's. More migrations live than the tag knows would need the
pre-migration backup restored, and fewer would be a release; both are refused. The host tooling for a rollback
comes from the laptop checkout's HEAD, since an older tag may predate it.

**Releases with migrations** aren't supported by these commands yet. A newer migration stops an older commit
from starting (it refuses the database), so rolling back across one means restoring the runtime's
`before-<migration>` backup, and anything logged since is lost unless carried over by hand. Until the tooling
covers it (stopped-database backup, fingerprint, off-host receipt, restore rollback), such a release needs its
own reviewed kit.

**Checking the tooling**: `bash deploy/release.test.sh` rehearses all of the above on a fake host in a temp
directory (systemd, ssh, sudo, Serve, Restic and `gh` stubbed; the real runtime, build and tests). It never
contacts a host.

## Day to day

```bash
systemctl status sahale            journalctl -u sahale -f
cat /opt/sahale/DEPLOYED           # what is deployed: tag, commit, migrations, last pre-release snapshot
```

Each morning after the backup window (and on every release morning, before releasing):

```bash
ssh -t <host> 'sudo bash /opt/sahale/app/deploy/cp3.sh overnight'
```

It checks, read-only, that last night's snapshot and both Restic jobs ran in their slots and hold tonight's
copy, and that the snapshot has the deployed commit's schema. The commit and migration count come from
`/opt/sahale/DEPLOYED` (or, before the first `deploy/release`, from `git rev-parse` in `/opt/sahale/app` and its
migration journal). A pass ends `overnight: N checks passed.` and is the gate the next release checks.
