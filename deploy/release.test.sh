#!/bin/bash
# Rehearsals of deploy/release, deploy/rollback, release-host.sh and cp3.sh, entirely on this machine:
#   - a throwaway clone of this checkout (plus its uncommitted changes) with scratch tags v0.9.x and a local
#     bare "origin";
#   - a fake host: a temp dir with /opt/sahale, /var/lib/sahale, /etc/sahale, /etc/systemd/system, /opt/node;
#     the deployed app is a scratch checkout and its database is created by the app's own migrations;
#   - stubs for ssh, scp, sudo, runuser, systemctl, journalctl, tailscale, pgrep, restic and gh. The fake
#     "sahale.service" runs the real runtime from the fake /opt/sahale/app on a scratch port.
# No real store, no network host, nothing outside the temp dir is written. npm ci is replaced by a hardlinked
# copy of this checkout's node_modules when the lockfile is identical; build and tests are real.
#
#   bash deploy/release.test.sh          (KEEP=1 keeps the temp dir for inspection)
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT=${SAHALE_TEST_PORT:-4391}
ME=$(id -un)
T=$(mktemp -d "${TMPDIR:-/tmp}/sahale-release-test.XXXXXX")
touch "$T/RELEASE-TEST-DISPOSABLE"
ROOT=$T/host
FAKE=$T/fake
LAPTOP=$T/laptop
BIN=$T/bin
REAL_NPM=$(command -v npm)
REAL_PGREP=$(command -v pgrep)
mkdir -p "$FAKE/ci" "$BIN" "$T/home"

TESTS=0 FAILED=0
pass() { TESTS=$((TESTS + 1)); printf '  PASS %s\n' "$*"; }
flunk() { TESTS=$((TESTS + 1)); FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$*"; }
section() { printf '\n### %s\n' "$*"; }
check() { local d=$1; shift; if "$@"; then pass "$d"; else flunk "$d"; fi; }
die() { printf 'test setup failed: %s\n' "$*" >&2; exit 2; }

cleanup() {
  "$BIN/systemctl" stop sahale >/dev/null 2>&1 || true
  if [[ ${KEEP:-0} == 1 ]]; then echo "kept: $T"; return; fi
  [[ -f $T/RELEASE-TEST-DISPOSABLE ]] && rm -rf -- "$T"
}
trap cleanup EXIT

[[ -z $(ss -ltnH "sport = :$PORT") ]] || die "port $PORT is in use (SAHALE_TEST_PORT=<free port>)"
[[ -d $SRC/node_modules ]] || die "run npm ci in $SRC first"

# ---------------------------------------------------------------- stubs
cat > "$FAKE/env" <<EOF
FAKE=$FAKE
FAKE_ROOT=$ROOT
FAKE_PORT=$PORT
SRC=$SRC
REAL_NPM=$REAL_NPM
REAL_PGREP=$REAL_PGREP
ME=$ME
EOF
stub() { { printf '#!/bin/bash\nset -euo pipefail\n. %q\n' "$FAKE/env"; cat; } > "$BIN/$1"; chmod +x "$BIN/$1"; }

stub ssh <<'EOF'
# fake ssh: runs the command on the fake host (this machine) from the admin's fake home.
echo "ssh $*" >> "$FAKE/calls"
while [[ $1 == -* ]]; do case $1 in -o) shift 2 ;; *) shift ;; esac; done
host=$1; shift
[[ $host == fakehost ]] || { echo "fake ssh: unknown host $host" >&2; exit 255; }
cd "$FAKE_ROOT/home/$ME" && exec bash -c "$*"
EOF
stub scp <<'EOF'
echo "scp $*" >> "$FAKE/calls"
files=()
for a in "$@"; do [[ $a == -* ]] || files+=("$a"); done
dest=${files[-1]}; unset 'files[-1]'
[[ $dest == fakehost:* ]] || { echo "fake scp: unknown host in $dest" >&2; exit 1; }
cp -p "${files[@]}" "$FAKE_ROOT/home/$ME/${dest#fakehost:}"
EOF
stub sudo <<'EOF'
echo "sudo $*" >> "$FAKE/calls"
exec "$@"
EOF
stub runuser <<'EOF'
[[ $1 == -u && $3 == -- ]] || { echo "fake runuser: $*" >&2; exit 1; }
shift 3; exec "$@"
EOF
stub tailscale <<'EOF'
[[ "$*" == "serve status" ]] || { echo "fake tailscale: refusing $*" >&2; exit 1; }
printf 'https://sahale-fake.example:8443 (tailnet only)\n|-- / proxy http://127.0.0.1:%s\n' "$FAKE_PORT"
EOF
stub pgrep <<'EOF'
pid=$(cat "$FAKE/sahale.pid" 2>/dev/null || true)
case "$*" in
  "-u sahale" | "-au sahale") [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null && { echo "$pid"; exit 0; }; exit 1 ;;
  "-x restic") exit 1 ;;
  *) exec "$REAL_PGREP" "$@" ;;
esac
EOF
stub systemctl <<'EOF'
# fake systemd: "sahale" runs the real runtime from the fake /opt/sahale/app with the unit's environment.
pidf=$FAKE/sahale.pid
alive() { local p; p=$(cat "$pidf" 2>/dev/null) && [[ -n $p ]] && kill -0 "$p" 2>/dev/null; }
kv() { sed -n "s/^$2=//p" "$1" | head -n 1; }
slot() { case $1 in sahale-snapshot.service) echo 02:45:05 ;; *-b2*) echo 04:00:01 ;; *) echo 03:00:01 ;; esac; }
case "$*" in
  "is-active sahale") if alive; then echo active; else echo inactive; exit 3; fi ;;
  "is-enabled sahale" | "is-enabled sahale-snapshot.timer") echo enabled ;;
  "is-active sahale-snapshot.timer") echo active ;;
  "show -P Environment sahale") echo "NODE_ENV=production SAHALE_SERVE_STATIC=1 SAHALE_DATA_DIR=$FAKE_ROOT/var/lib/sahale SAHALE_PORT=$FAKE_PORT" ;;
  "show -P DropInPaths "*) echo "" ;;
  "show -P ActiveState "*) echo inactive ;;
  "show -P Result "*) echo success ;;
  "show --timestamp=unix -P ExecMainStartTimestamp "*) echo "@$(date -d "today $(slot "$5")" +%s)" ;;
  "--failed --plain --no-legend") : ;;
  "stop sahale")
    if alive; then
      p=$(cat "$pidf"); kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p"
      for _ in $(seq 1 40); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
      ! kill -0 "$p" 2>/dev/null || { echo "fake systemctl: $p did not stop" >&2; exit 1; }
    fi
    rm -f "$pidf" ;;
  "start sahale")
    alive && exit 0
    app=$FAKE_ROOT/opt/sahale/app env=$FAKE_ROOT/etc/sahale/sahale.env
    printf '%s %s\n' "$(date +%s)" "$(stat -c %s "$FAKE/journal" 2>/dev/null || echo 0)" >> "$FAKE/starts"
    cd "$app"
    setsid env -i PATH="$FAKE_ROOT/opt/node/bin:/usr/bin:/bin" HOME="$FAKE_ROOT/var/lib/sahale" NODE_ENV=production SAHALE_SERVE_STATIC=1 \
      SAHALE_DATA_DIR="$FAKE_ROOT/var/lib/sahale" SAHALE_PORT="$FAKE_PORT" SAHALE_PUBLIC_ORIGIN="$(kv "$env" SAHALE_PUBLIC_ORIGIN)" \
      SAHALE_OWNER_LOGIN="$(kv "$env" SAHALE_OWNER_LOGIN)" "$FAKE_ROOT/opt/node/bin/node" "$app/node_modules/tsx/dist/cli.mjs" server/index.ts \
      >> "$FAKE/journal" 2>&1 < /dev/null &
    echo $! > "$pidf" ;;
  *) echo "fake systemctl: unsupported: $*" >&2; exit 1 ;;
esac
EOF
stub journalctl <<'EOF'
# journalctl -u sahale --since @<t> --no-pager -o cat: the runtime output from the first start at or after t.
since=''
while (($#)); do case $1 in --since) since=${2#@}; shift 2 ;; *) shift ;; esac; done
off=$(awk -v t="$since" '$1 >= t { print $2; exit }' "$FAKE/starts" 2>/dev/null)
[[ -n $off ]] || exit 0
tail -c +"$((off + 1))" "$FAKE/journal"
EOF
stub restic <<'EOF'
# fake restic: one Sahale snapshot from tonight in each repository, holding the current snapshot file.
case "$*" in
  *"snapshots --json"*) printf '[{"id":"%s","time":"%sT03:00:05.123Z","paths":["/var/lib/sahale/snapshots/sahale-latest.db"],"tags":["sahale"]}]\n' "$(printf 'a%.0s' $(seq 64))" "$(date +%F)" ;;
  *"dump latest --tag sahale"*) cat "$FAKE_ROOT/var/lib/sahale/snapshots/sahale-latest.db" ;;
  *"list locks"*) : ;;
  *) echo "fake restic: unsupported: $*" >&2; exit 1 ;;
esac
EOF
stub gh <<'EOF'
# gh run list --commit <sha> --workflow CI --json …: from $FAKE/ci/<sha> ("completed success", "queued", …).
sha=''; while (($#)); do case $1 in --commit) sha=$2; shift 2 ;; *) shift ;; esac; done
f=$FAKE/ci/$sha
[[ -f $f ]] || { echo '[]'; exit 0; }
read -r status conclusion < "$f"
printf '[{"status":"%s","conclusion":"%s","url":"https://ci.example.invalid/%s"}]\n' "$status" "${conclusion:-}" "${sha:0:7}"
EOF

export PATH=$BIN:$PATH HOME=$T/home
unset XDG_CONFIG_HOME XDG_STATE_HOME   # CI runners set these; release must read the fake home
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
for c in ssh scp sudo systemctl tailscale restic gh; do [[ $(command -v $c) == "$BIN/$c" ]] || die "$c is not the stub"; done

# ---------------------------------------------------------------- throwaway repo, scratch tags
section "setup: throwaway clone and tags"
git clone -q "$SRC" "$LAPTOP"
git init -q --bare "$T/origin.git"
git -C "$LAPTOP" remote set-url origin "$T/origin.git"
# The working tree as it is now, uncommitted changes included, so the rehearsal tests what is on disk.
(cd "$SRC" && git ls-files -z -c -o --exclude-standard | tar --null -T - --ignore-failed-read -cf - 2>/dev/null) | tar -C "$LAPTOP" -xf -
git -C "$LAPTOP" add -A
git -C "$LAPTOP" diff --cached --quiet || git -C "$LAPTOP" commit -q -m "tooling under test (working tree)"
BASE=$(git -C "$LAPTOP" rev-parse HEAD)

set_version() { # set_version <x.y.z> [runtime version]
  (cd "$LAPTOP" && python3 - "$1" <<'PY'
import json, sys
v = sys.argv[1]
for f in ("package.json", "package-lock.json"):
    d = json.load(open(f))
    d["version"] = v
    if f == "package-lock.json": d["packages"][""]["version"] = v
    open(f, "w").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
  sed -i "s/^export const VERSION = '.*'$/export const VERSION = '${2:-$1}'/" "$LAPTOP/server/routes/runtime.ts")
}
tag() { # tag <vX.Y.Z> <ci result|none>: commit what is staged, tag, push the tag, record CI
  git -C "$LAPTOP" add -A
  git -C "$LAPTOP" commit -q -m "$1"
  git -C "$LAPTOP" tag -a "$1" -m "$1"
  git -C "$LAPTOP" push -q origin "refs/tags/$1"
  [[ $2 == none ]] || echo "$2" > "$FAKE/ci/$(git -C "$LAPTOP" rev-parse "$1^{commit}")"
}
set_version 0.9.0; tag v0.9.0 "completed success"
echo "release rehearsal change" >> "$LAPTOP/README.md"; set_version 0.9.1; tag v0.9.1 "completed success"
set_version 0.9.2; tag v0.9.2 "completed failure"
git -C "$LAPTOP" checkout -q --detach v0.9.1
set_version 0.9.3 0.9.1; tag v0.9.3 "completed success"            # runtime.ts still says 0.9.1
git -C "$LAPTOP" checkout -q --detach v0.9.1
printf 'CREATE TABLE `release_probe` (`id` integer PRIMARY KEY NOT NULL);\n' > "$LAPTOP/server/db/migrations/0004_release_probe.sql"
python3 - "$LAPTOP/server/db/migrations/meta/_journal.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["entries"].append({"idx": len(d["entries"]), "version": "6", "when": d["entries"][-1]["when"] + 1000, "tag": "0004_release_probe", "breakpoints": True})
open(p, "w").write(json.dumps(d, indent=2) + "\n")
PY
set_version 0.9.4; tag v0.9.4 "completed success"                  # adds a migration
git -C "$LAPTOP" checkout -q --detach "$BASE"
set_version 0.9.5; tag v0.9.5 "completed success"                  # a sibling: v0.9.0/v0.9.1 are not its ancestors
git -C "$LAPTOP" checkout -q --detach v0.9.1
python3 - "$LAPTOP/server/index.ts" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("async function main() {\n", "async function main() {\n  if (process.env.NODE_ENV === 'production') throw new Error('release rehearsal: this build does not start')\n", 1)
open(p, "w").write(s)
PY
set_version 0.9.6; tag v0.9.6 "completed success"                  # builds and tests, never becomes ready
git -C "$LAPTOP" checkout -q --detach v0.9.1
echo "# release rehearsal: a unit change" >> "$LAPTOP/deploy/sahale.service"
set_version 0.9.8; tag v0.9.8 "completed success"                  # changes a unit file
git -C "$LAPTOP" checkout -q --detach v0.9.1
git -C "$LAPTOP" checkout -q --detach "$BASE"
rm "$LAPTOP/server/db/migrations/0003_career_applications.sql" "$LAPTOP/server/db/migrations/meta/0003_snapshot.json"
python3 - "$LAPTOP/server/db/migrations/meta/_journal.json" <<'PY2'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["entries"].pop()
open(p, "w").write(json.dumps(d, indent=2) + "\n")
PY2
set_version 0.1.2; tag v0.1.2 none                                 # an old release with fewer migrations
git -C "$LAPTOP" checkout -q --detach v0.9.1
git -C "$LAPTOP" status --porcelain | grep -q . && die "throwaway clone not clean"
echo "  tags: $(git -C "$LAPTOP" tag -l 'v0.9.*' | paste -sd' ' -) (+ v0.1.2)"

# ---------------------------------------------------------------- fake host
section "setup: fake host with v0.9.0 deployed (no DEPLOYED record yet)"
mkdir -p "$ROOT"/{opt/sahale,opt/node/bin,etc/sahale,etc/systemd/system,var/lib/sahale/snapshots} "$ROOT/home/$ME/sahale-release/cp3-overnight" "$ROOT/home/$ME/homelab"
chmod 0700 "$ROOT/var/lib/sahale"
touch "$ROOT/FAKE-HOST"
ln -s "$(command -v node)" "$ROOT/opt/node/bin/node"
cat > "$ROOT/opt/node/bin/npm" <<EOF
#!/bin/bash
# fake host npm: 'ci' is a hardlinked copy of the test checkout's node_modules when the lockfile is identical
# (no registry access); everything else is the real npm.
set -euo pipefail
if [[ \${1:-} == ci ]] && cmp -s package-lock.json $(printf %q "$SRC/package-lock.json"); then
  [[ ! -e node_modules ]] || mv node_modules ".node_modules.old.\$\$"
  cp -al $(printf %q "$SRC/node_modules") node_modules
  rm -rf node_modules/.tmp node_modules/.vite ".node_modules.old.\$\$"
  echo "fake host: node_modules hardlinked from the test checkout (lockfile identical)"
  exit 0
fi
exec $(printf %q "$REAL_NPM") "\$@"
EOF
chmod +x "$ROOT/opt/node/bin/npm"
APP=$ROOT/opt/sahale/app
git clone -q --branch v0.9.0 "$LAPTOP" "$APP" 2>/dev/null
(cd "$APP" && PATH=$ROOT/opt/node/bin:$PATH npm ci >/dev/null && PATH=$ROOT/opt/node/bin:$PATH npm run build > "$T/setup-build.log" 2>&1) || die "deployed app build"
for f in sahale.service sahale-snapshot.service sahale-snapshot.timer; do cp "$APP/deploy/$f" "$ROOT/etc/systemd/system/$f"; done
printf 'SAHALE_PUBLIC_ORIGIN=https://sahale-fake.example:8443\nSAHALE_OWNER_LOGIN=owner@example.invalid\n' > "$ROOT/etc/sahale/sahale.env"
H=$ROOT/home/$ME/homelab
cat > "$ROOT/etc/sahale/release.conf" <<EOF
# fake host
QUIET_WINDOW=0000-0000
READY_TIMEOUT=20
RESTIC_LOCAL_UNIT=fake-restic-backup.service
RESTIC_B2_UNIT=fake-restic-backup-b2.service
RESTIC_LOCAL_SCRIPT=$H/restic-backup.sh
RESTIC_B2_SCRIPT=$H/restic-backup-b2.sh
RESTIC_LOCAL_REPO=$H/restic-repo
RESTIC_B2_REPO=b2:fake-bucket:restic
RESTIC_B2_ENV=$H/b2.env
RESTIC_LOCAL_STAMP=$H/last-local.txt
RESTIC_B2_STAMP=$H/last-b2.txt
BACKUPS_JSON=$H/backups.json
SLOT_SNAPSHOT=0245
SLOT_LOCAL=0300
SLOT_B2=0400
CP3_OUT=$ROOT/home/$ME/sahale-release/cp3-overnight
CP3_GATE_DIRS="$ROOT/home/$ME/sahale-release/cp3-overnight"
EOF
echo "fake" > "$H/pw"
printf 'PASSWORD_FILE="%s"\n' "$H/pw" | tee "$H/restic-backup.sh" > "$H/restic-backup-b2.sh"
printf 'B2_ACCOUNT_ID=fake\nB2_ACCOUNT_KEY=fake\n' > "$H/b2.env"
date '+%F 03:00:11' > "$H/last-local.txt"; date '+%F 04:00:32' > "$H/last-b2.txt"
printf '{"local":{"last_success":"%s","fresh":true},"b2":{"last_success":"%s","fresh":true}}\n' "$(date +%F)" "$(date +%F)" > "$H/backups.json"
cat > "$T/home/release.env" <<EOF
SAHALE_SSH=fakehost
SAHALE_ADMIN=$ME
SAHALE_HOST_ROOT=$ROOT
EOF
mkdir -p "$T/home/.config/sahale" && mv "$T/home/release.env" "$T/home/.config/sahale/release.env"

U=http://127.0.0.1:$PORT
health() { curl -s -m 5 "$U/api/runtime/health" || true; }
version() { curl -s -m 5 "$U/api/runtime" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null || echo none; }
api() { if (($# >= 3)); then curl -s -m 10 -H 'x-sahale-client: 1' -H 'content-type: application/json' -X "$1" "$U$2" -d "$3"; else curl -s -m 10 -H 'x-sahale-client: 1' -X "$1" "$U$2"; fi; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
"$BIN/systemctl" start sahale
for _ in $(seq 1 60); do [[ $(health) == '{"ok":true,"db":"ready"}' ]] && break; sleep 0.5; done
[[ $(health) == '{"ok":true,"db":"ready"}' ]] || die "fake runtime did not start: $(tail -n 20 "$FAKE/journal")"
grep -q 'database   ready' "$FAKE/journal" || die "no banner"
# Some owner data, logged through the API like the UI: one finished workout.
tpl=$(api POST /api/fitness/templates '{"name":"Rehearsal Upper","items":[{"exerciseId":"bench-press","sets":2,"repMin":5,"repMax":8}]}' | jget 'd["id"]')
sid=$(api POST /api/fitness/sessions "{\"templateId\":\"$tpl\"}" | jget 'd["id"]')
for s in $(api GET /api/fitness | jget '" ".join(x["id"] for e in d["active"]["entries"] for x in e["sets"])'); do api PATCH "/api/fitness/sets/$s" '{"weight":135,"reps":8,"done":true}' > /dev/null; done
api POST "/api/fitness/sessions/$sid/finish" '{"durationMin":50}' > /dev/null
python3 "$APP/deploy/sahale-sqlite.py" snapshot "$ROOT/var/lib/sahale/sahale.db" "$ROOT/var/lib/sahale/snapshots/sahale-latest.db" > /dev/null
python3 "$APP/deploy/sahale-sqlite.py" check "$ROOT/var/lib/sahale/snapshots/sahale-latest.db" | grep -q '^session ' || die "no owner session in the fake database"
echo "  fake host: v0.9.0 running on :$PORT, database from its migrations, one owner workout"

host_state() { # what a refused run must leave unchanged
  printf '%s|%s|%s|%s|%s\n' "$(git -C "$APP" rev-parse HEAD)" "$(health)" "$(version)" "$(cat "$ROOT/opt/sahale/DEPLOYED" 2>/dev/null | sha256sum)" "$(ls -d "$ROOT"/opt/sahale/app* | paste -sd' ' -)"
}
deployed() { sed -n "s/^$1=//p" "$ROOT/opt/sahale/DEPLOYED"; }
calls() { grep -c "^$1 " "$FAKE/calls" 2>/dev/null || true; }
run() { # run <log name> <command…>: output to $T/<name>.out; returns the command's status
  local name=$1; shift
  set +e; "$@" > "$T/$name.out" 2>&1; local rc=$?; set -e
  return $rc
}
refused() { # refused <description> <pattern> <log name> <command…>
  local d=$1 pat=$2 name=$3; shift 3
  if run "$name" "$@"; then flunk "$d: exit 0 ($T/$name.out)"; tail -n 5 "$T/$name.out" | sed 's/^/      /'
  elif grep -qE -- "$pat" "$T/$name.out"; then pass "$d: $(grep -oE -- "$pat" "$T/$name.out" | head -n 1)"
  else flunk "$d: refused, but not with /$pat/ ($T/$name.out)"; tail -n 5 "$T/$name.out" | sed 's/^/      /'; fi
}
REL=$LAPTOP/deploy/release
RBK=$LAPTOP/deploy/rollback
CP3() { sudo bash "$APP/deploy/cp3.sh" overnight --root "$ROOT"; }

# ---------------------------------------------------------------- cp3
section "cp3.sh overnight (no DEPLOYED yet: expectations from git)"
if run cp3-first CP3; then pass "cp3 overnight passes: $(tail -n 1 "$T/cp3-first.out" | cut -c1-40)"; else flunk "cp3 overnight ($T/cp3-first.out)"; tail -n 8 "$T/cp3-first.out"; fi
check "it said where its expectations came from" grep -q "no .*/DEPLOYED: expected commit from git" "$T/cp3-first.out"

# ---------------------------------------------------------------- dry runs (no host contact)
section "dry runs"
: > "$FAKE/calls"
if run dry-happy "$REL" v0.9.1 --dry-run; then pass "dry run v0.9.1 completes"; else flunk "dry run v0.9.1 ($T/dry-happy.out)"; tail -n 15 "$T/dry-happy.out"; fi
check "dry run prints the host plan (ssh -t … sudo bash …release-host.sh release v0.9.1)" grep -q "ssh -t fakehost 'sudo bash sahale-release/v0.9.1/release-host.sh release v0.9.1" "$T/dry-happy.out"
check "dry run prints the switch and swap-back steps" grep -q '\[swap-back\]' "$T/dry-happy.out"
check "dry run ran nothing on the host (no ssh, scp or sudo)" test "$(wc -l < "$FAKE/calls")" -eq 0
mv "$T/home/.config/sahale/release.env" "$T/release.env.aside"
if run dry-noconf "$REL" v0.9.1 --dry-run; then pass "dry run without release.env completes"; else flunk "dry run without release.env ($T/dry-noconf.out)"; tail -n 5 "$T/dry-noconf.out"; fi
check "it shows placeholders and the whole host plan" grep -q "ssh -t '<ssh alias>'\|ssh -t <ssh alias> .*release-host.sh release v0.9.1" "$T/dry-noconf.out"
check "including the host steps" grep -q '\[record\]' "$T/dry-noconf.out"
mv "$T/release.env.aside" "$T/home/.config/sahale/release.env"
refused "dry run: CI not green" "CI on [0-9a-f]+ is 'failure'" dry-ci "$REL" v0.9.2 --dry-run
check "a refused dry run still prints the whole plan" grep -q '\[swap-back\]' "$T/dry-ci.out"
check "and says it would refuse" grep -q 'would refuse this release' "$T/dry-ci.out"
echo queued > "$FAKE/ci/$(git -C "$LAPTOP" rev-parse v0.9.1^{commit})"
refused "dry run: CI still queued" "is 'queued'" dry-queued "$REL" v0.9.1 --dry-run
echo "completed success" > "$FAKE/ci/$(git -C "$LAPTOP" rev-parse v0.9.1^{commit})"
refused "dry run: version mismatch" "versions at v0.9.3 .*expected '0.9.3 0.9.3 0.9.3 0.9.3', got '0.9.3 0.9.3 0.9.3 0.9.1'" dry-version "$REL" v0.9.3 --dry-run
refused "dry run: tag adds a migration" "adds migrations \(0004_release_probe\)" dry-migration "$REL" v0.9.4 --dry-run --deployed v0.9.0
refused "dry run: deployed commit not an ancestor" "is not an ancestor of v0.9.5" dry-ancestor "$REL" v0.9.5 --dry-run --deployed v0.9.0
refused "dry run: tag changes a unit file" "deploy/sahale.service differs between the deployed commit and v0.9.8" dry-unit "$REL" v0.9.8 --dry-run --deployed v0.9.0
touch "$LAPTOP/stray-file"
refused "dry run: dirty working tree" "working tree clean" dry-dirty "$REL" v0.9.1 --dry-run
rm -f "$LAPTOP/stray-file"
git -C "$LAPTOP" tag -a v0.9.7 -m v0.9.7 "v0.9.1^{commit}"
refused "dry run: tag not pushed" "v0.9.7 is not on origin" dry-unpushed "$REL" v0.9.7 --dry-run
git -C "$LAPTOP" tag -d v0.9.7 > /dev/null
refused "--deployed outside a dry run" "for --dry-run only" dry-flag "$REL" v0.9.1 --deployed v0.9.0
cp "$T/home/.config/sahale/release.env" "$T/release.env.good"
echo "SAHALE_SUDO_NOPASSWD=1" >> "$T/home/.config/sahale/release.env"
refused "a request for passwordless sudo" "passwordless or scripted sudo is not supported" dry-nopasswd "$REL" v0.9.1 --dry-run
cp "$T/release.env.good" "$T/home/.config/sahale/release.env"
check "refused dry runs ran nothing on the host" test "$(wc -l < "$FAKE/calls")" -eq 0

# ---------------------------------------------------------------- real runs that the laptop refuses after reading the host
section "fake host: refused before anything is sent"
before=$(host_state); : > "$FAKE/calls"
refused "release v0.9.4 (adds a migration)" "adds migrations \(0004_release_probe\)" laptop-migration "$REL" v0.9.4
refused "release v0.9.5 (deployed v0.9.0 not an ancestor)" "is not an ancestor of v0.9.5" laptop-ancestor "$REL" v0.9.5
check "only the read-only ssh ran: no scp, no sudo" test "$(calls scp)$(calls sudo)" == 00
check "production unchanged" test "$(host_state)" == "$before"

# ---------------------------------------------------------------- the host refuses on its own (laptop checks bypassed)
section "fake host: release-host.sh refuses on its own (laptop bypassed)"
make_kit() { # make_kit <mode> <tag> <tool rev>: the kit deploy/release would send, in place on the fake host; prints its dir
  local mode=$1 tag=$2 k
  if [[ $mode == release ]]; then k=$ROOT/home/$ME/sahale-release/$tag; else k=$ROOT/home/$ME/sahale-release/rollback-$tag; fi
  mkdir -p "$k"
  git -C "$LAPTOP" bundle create -q "$k/$tag.bundle" "refs/tags/$tag"
  for f in release-host.sh release-lib.sh sahale-sqlite.py; do git -C "$LAPTOP" show "$3:deploy/$f" > "$k/$f"; done
  (cd "$k" && sha256sum "$tag.bundle" release-host.sh release-lib.sh sahale-sqlite.py > SHA256SUMS)
  echo "$k"
}
host_direct() { # host_direct <mode> <tag> <tool rev> [sums]: run that kit straight on the fake host
  local k; k=$(make_kit "$1" "$2" "$3")
  sudo bash "$k/release-host.sh" "$1" "$2" "$(git -C "$LAPTOP" rev-parse "$2^{commit}")" "${4:-$(sha256sum "$k/SHA256SUMS" | cut -d' ' -f1)}" --admin "$ME" --root "$ROOT"
}
before=$(host_state)
refused "host: v0.9.4 changes server/db/migrations" "v0.9.4 changes server/db/migrations" host-migration host_direct release v0.9.4 v0.9.4
refused "host: deployed not an ancestor of v0.9.5" "is not an ancestor of v0.9.5" host-ancestor host_direct release v0.9.5 v0.9.5
refused "host: v0.9.8 changes a unit file" "v0.9.8's deploy/sahale.service differs from the installed" host-unit host_direct release v0.9.8 v0.9.8
refused "host: a kit whose SHA256SUMS is not the one the laptop sent" "is not the one the laptop sent" host-sums host_direct release v0.9.1 v0.9.1 "$(printf '0%.0s' $(seq 64))"
check "production unchanged" test "$(host_state)" == "$before"

# ---------------------------------------------------------------- happy path
section "fake host: release v0.9.1 (happy path)"
: > "$FAKE/calls"
if run release-091 "$REL" v0.9.1; then pass "release v0.9.1 exits 0"; else flunk "release v0.9.1 ($T/release-091.out)"; tail -n 25 "$T/release-091.out"; fi
check "exactly one sudo session" test "$(calls sudo)" -eq 1
check "running v0.9.1, ready" test "$(version) $(health)" == '0.9.1 {"ok":true,"db":"ready"}'
check "/opt/sahale/app is v0.9.1" test "$(git -C "$APP" rev-parse HEAD)" == "$(git -C "$LAPTOP" rev-parse v0.9.1^{commit})"
check "v0.9.0 kept as app-$(git -C "$LAPTOP" rev-parse --short=7 v0.9.0^{commit}) (no DEPLOYED tag before)" test -d "$ROOT/opt/sahale/app-$(git -C "$LAPTOP" rev-parse --short=7 v0.9.0^{commit})"
check "DEPLOYED: tag, commit, 4 migrations, snapshot sha256" test "$(deployed tag) $(deployed commit) $(deployed migrations) $(sha256sum "$(deployed snapshot)" | cut -d' ' -f1)" \
  == "v0.9.1 $(git -C "$LAPTOP" rev-parse v0.9.1^{commit}) 4 $(deployed snapshot_sha256)"
check "DEPLOYED is 0644" test "$(stat -c %a "$ROOT/opt/sahale/DEPLOYED")" == 644
check "releases.log line, copied to the laptop" test "$(tail -n 1 "$ROOT/opt/sahale/releases.log")" == "$(tail -n 1 "$T/home/.local/state/sahale/releases.log")"
check "the staged tree's tests ran" grep -qE 'ok   tests: Tests [0-9]+ passed' "$T/release-091.out"
check "startup applied nothing" grep -qE '^ +database +ready$' "$T/release-091.out"
check "owner-only matrix checked" grep -q 'ok   default :443 host (forbidden_host)' "$T/release-091.out"
check "live database = stopped database" grep -q 'live database = the stopped one' "$T/release-091.out"

section "cp3.sh overnight after the release (expectations from DEPLOYED)"
python3 "$APP/deploy/sahale-sqlite.py" snapshot "$ROOT/var/lib/sahale/sahale.db" "$ROOT/var/lib/sahale/snapshots/sahale-latest.db" > /dev/null
if run cp3-deployed CP3; then pass "cp3 overnight passes on v0.9.1"; else flunk "cp3 overnight ($T/cp3-deployed.out)"; tail -n 8 "$T/cp3-deployed.out"; fi
check "it read DEPLOYED" grep -q "expected from .*/DEPLOYED: v0.9.1" "$T/cp3-deployed.out"
cp "$ROOT/opt/sahale/DEPLOYED" "$T/DEPLOYED.good"
sed -i 's/^migrations=.*/migrations=5/' "$ROOT/opt/sahale/DEPLOYED"
refused "cp3 overnight fails when DEPLOYED expects another schema" "unexpected migrations 4 applied.*expected 5" cp3-wrong CP3
cp "$T/DEPLOYED.good" "$ROOT/opt/sahale/DEPLOYED"
if run cp3-again CP3; then pass "cp3 overnight passes again (today's gate for the next runs)"; else flunk "cp3 again ($T/cp3-again.out)"; fi

# ---------------------------------------------------------------- failed post-switch check
section "fake host: release v0.9.6 (never ready) swaps back"
: > "$FAKE/calls"
refused "release v0.9.6 fails" "v0.9.6 is not ready after 20s" release-096 "$REL" v0.9.6
check "it swapped back on its own" grep -q 'SWAPPED BACK: v0.9.1 is running again' "$T/release-096.out"
check "running v0.9.1 again, ready" test "$(version) $(health)" == '0.9.1 {"ok":true,"db":"ready"}'
check "/opt/sahale/app is v0.9.1 again" test "$(git -C "$APP" rev-parse HEAD)" == "$(git -C "$LAPTOP" rev-parse v0.9.1^{commit})"
check "DEPLOYED still v0.9.1" test "$(deployed tag)" == v0.9.1
check "releases.log records the swap-back" grep -q 'release v0.9.6 .* result=swapped-back' "$ROOT/opt/sahale/releases.log"
check "the laptop did not record it" bash -c "! grep -q v0.9.6 '$T/home/.local/state/sahale/releases.log'"
check "the failed tree is kept for inspection" bash -c "ls -d '$ROOT'/opt/sahale/app-v0.9.6-failed-* >/dev/null"
check "no app-v0.9.1 left behind" test ! -e "$ROOT/opt/sahale/app-v0.9.1"

# ---------------------------------------------------------------- rollback
section "fake host: rollback"
before=$(host_state); : > "$FAKE/calls"
refused "rollback to v0.1.2 (the live database has more migrations)" "1 more migration\(s\) than v0.1.2" rbk-laptop-more "$RBK" v0.1.2
refused "rollback to v0.9.4 (it has migrations the live database lacks)" "that is a release, not a rollback" rbk-laptop-fewer "$RBK" v0.9.4
refused "host: rollback to v0.1.2 refused on its own" "the live database has 4 migrations, v0.1.2 knows 3" rbk-host-more host_direct rollback v0.1.2 HEAD
refused "host: rollback to v0.9.4 refused on its own" "that is a release with migrations, not a rollback" rbk-host-fewer host_direct rollback v0.9.4 HEAD
check "production unchanged by the refusals" test "$(host_state)" == "$before"
: > "$FAKE/calls"
if run rollback-090 "$RBK" v0.9.0; then pass "rollback to v0.9.0 exits 0"; else flunk "rollback v0.9.0 ($T/rollback-090.out)"; tail -n 25 "$T/rollback-090.out"; fi
check "exactly one sudo session" test "$(calls sudo)" -eq 1
check "running v0.9.0, ready" test "$(version) $(health)" == '0.9.0 {"ok":true,"db":"ready"}'
check "it used the kept tree (no re-stage)" grep -q 'kept working tree clean' "$T/rollback-090.out"
check "DEPLOYED: v0.9.0, action rollback" test "$(deployed tag) $(deployed action)" == "v0.9.0 rollback"
check "v0.9.1 kept as app-v0.9.1" test "$(git -C "$ROOT/opt/sahale/app-v0.9.1" rev-parse HEAD)" == "$(git -C "$LAPTOP" rev-parse v0.9.1^{commit})"
check "releases.log: rollback line" grep -q 'rollback v0.9.0 .* from=v0.9.1 .*result=ok' "$ROOT/opt/sahale/releases.log"

section "fake host: release v0.9.1 again (reuses the kept tree)"
if run release-091b "$REL" v0.9.1; then pass "release v0.9.1 again exits 0"; else flunk "re-release v0.9.1 ($T/release-091b.out)"; tail -n 25 "$T/release-091b.out"; fi
check "it rebuilt the kept tree instead of cloning" grep -q 'already at .*building it again' "$T/release-091b.out"
check "running v0.9.1" test "$(version)" == 0.9.1
check "DEPLOYED: v0.9.1 from v0.9.0" test "$(deployed tag) $(deployed previous_tag)" == "v0.9.1 v0.9.0"

printf '\nrelease.test.sh: %d checks, %d failed%s\n' "$TESTS" "$FAILED" "$([[ ${KEEP:-0} == 1 ]] && echo " (outputs in $T)")"
((FAILED == 0))
