# Sahale release library: the checks shared by release-host.sh and cp3.sh on the host.
# Sourced, not executed. Generalized from the v0.2.0 / v0.4.1 release kits: nothing here names a version,
# a commit, a tailnet or a host; those come from the tag, /opt/sahale/DEPLOYED and /etc/sahale/release.conf.
#
# Every host path hangs off ROOT, so a fake host (a temp dir with a FAKE-HOST marker) runs the same code.
# The caller sets ROOT (empty on the real host) and calls host_paths before anything else.

UNIT_FILES='sahale.service sahale-snapshot.service sahale-snapshot.timer'
PASS=0
SWITCHED=0      # 1 while the new tree is in place and not yet accepted: fail() then swaps back
IN_SWAPBACK=0
step() { printf '\n== %s\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$*"; }
note() { printf '  note %s\n' "$*"; }
fail() {
  printf '  FAIL %s\n' "$*"
  if [[ $IN_SWAPBACK == 1 ]]; then
    printf '\nSWAP-BACK FAILED. Sahale may be down. By hand, as root on the host:\n'
    printf '  systemctl stop sahale; mv %s %s.failed; mv %s %s; systemctl start sahale\n' "$APP" "$APP" "${KEPT:-<kept tree>}" "$APP"
    printf '  then: curl -s http://127.0.0.1:%s/api/runtime/health   (expect {"ok":true,"db":"ready"})\n' "${PORT:-4310}"
    exit 3
  fi
  if [[ $SWITCHED == 1 ]] && declare -F swap_back >/dev/null; then swap_back; exit 1; fi
  if [[ -n ${LOG:-} ]]; then printf '\nSTOPPED. Log: %s\n' "$LOG"; else printf '\nSTOPPED.\n'; fi
  exit 1
}
expect() { if [[ "$3" == "$2" ]]; then ok "$1 ($3)"; else fail "$1: expected '$2', got '$3'"; fi; }
indent() { sed 's/^/  /'; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
stamp() { date -u +%Y%m%d-%H%M%SZ; }
utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# host_paths: every host location, from ROOT.
host_paths() {
  OPT=$ROOT/opt/sahale
  APP=$OPT/app
  DEPLOYED_FILE=$OPT/DEPLOYED
  RELEASES_LOG=$OPT/releases.log
  DATA=$ROOT/var/lib/sahale
  DB=$DATA/sahale.db
  BACKUPS=$DATA/backups
  SNAP=$DATA/snapshots/sahale-latest.db
  ETC=$ROOT/etc/sahale
  ENVFILE=$ETC/sahale.env
  CONF=$ETC/release.conf
  UNITS=$ROOT/etc/systemd/system
  NODEBIN=$ROOT/opt/node/bin
}

# check_root: a real run is root via sudo; a fake one names a directory carrying the marker.
# Sets ADMIN (the account that owns /opt/sahale) and ADMIN_HOME.
check_root() { # check_root <expected admin or ''>
  if [[ -z $ROOT ]]; then
    [[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
    ADMIN=${SUDO_USER:-}
    [[ -n $ADMIN && $ADMIN != root ]] || { echo "run through sudo from the admin account, not as root directly" >&2; exit 1; }
  else
    [[ $ROOT == /* && $ROOT != / && -f $ROOT/FAKE-HOST ]] || { echo "--root $ROOT is not a fake host (no FAKE-HOST marker)" >&2; exit 1; }
    ADMIN=$(id -un)
  fi
  [[ -z $1 || $1 == "$ADMIN" ]] || { echo "admin is '$ADMIN', the laptop expects '$1'" >&2; exit 1; }
  if [[ -z $ROOT ]]; then ADMIN_HOME=$(getent passwd "$ADMIN" | cut -d: -f6); else ADMIN_HOME=$ROOT/home/$ADMIN; fi
}

# kv <file> <key>: the value of key=value in file (first match), nothing if absent. Never sourced.
kv() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1; }

# load_conf: /etc/sahale/release.conf, key=value lines only, known keys only (it is parsed, never sourced).
CONF_KEYS='QUIET_WINDOW READY_TIMEOUT RESTIC_LOCAL_UNIT RESTIC_B2_UNIT RESTIC_LOCAL_SCRIPT RESTIC_B2_SCRIPT RESTIC_LOCAL_REPO RESTIC_B2_REPO RESTIC_B2_ENV RESTIC_LOCAL_STAMP RESTIC_B2_STAMP BACKUPS_JSON SLOT_SNAPSHOT SLOT_LOCAL SLOT_B2 CP3_OUT CP3_GATE_DIRS'
load_conf() { # load_conf <required key>...
  [[ -f $CONF ]] || fail "$CONF missing: install deploy/release.conf.example there (root:root 0644) with this host's values"
  local line k v
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^([A-Z0-9_]+)=(.*)$ ]] || fail "$CONF: not key=value: $line"
    k=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}
    [[ " $CONF_KEYS " == *" $k "* ]] || fail "$CONF: unknown key $k"
    [[ $v =~ ^\"(.*)\"$ ]] && v=${BASH_REMATCH[1]}
    [[ $v != *'$'* && $v != *'`'* && $v != *'<'* ]] || fail "$CONF: $k still has a placeholder or shell syntax: $v"
    printf -v "$k" '%s' "$v"
  done < "$CONF"
  for k in "$@"; do [[ -n ${!k:-} ]] || fail "$CONF: $k is not set"; done
  [[ ${QUIET_WINDOW:-} =~ ^[0-9]{4}-[0-9]{4}$ ]] || fail "$CONF: QUIET_WINDOW must be HHMM-HHMM"
  READY_TIMEOUT=${READY_TIMEOUT:-90}
  # On a fake host every configured path must stay inside it.
  if [[ -n $ROOT ]]; then
    for k in RESTIC_LOCAL_SCRIPT RESTIC_B2_SCRIPT RESTIC_LOCAL_REPO RESTIC_B2_ENV RESTIC_LOCAL_STAMP RESTIC_B2_STAMP BACKUPS_JSON CP3_OUT; do
      [[ -z ${!k:-} || ${!k} == "$ROOT"/* ]] || fail "$CONF: $k=${!k} is outside the fake host $ROOT"
    done
    for v in ${CP3_GATE_DIRS:-}; do [[ $v == "$ROOT"/* ]] || fail "$CONF: $v is outside the fake host $ROOT"; done
  fi
}

as_sahale() { runuser -u sahale -- "$@"; }
as_admin() { runuser -u "$ADMIN" -- "$@"; }
# sahale-sqlite.py from the verified kit, fed on stdin so the sahale account needs no access to the kit.
sqlite_tool() { as_sahale python3 - "$@" < "$TOOL"; }
check_db() { sqlite_tool check "$1"; }   # read-only
PY=(runuser -u sahale -- python3)

# journal_line <_journal.json>: the migrations line sahale-sqlite.py check prints for a database at that journal.
journal_line() {
  python3 -c '
import json, sys
e = json.load(open(sys.argv[1]))["entries"]
print("migrations       %d applied, last %s" % (len(e), e[-1]["when"] if e else "-"))' "$1"
}

# The service's effective environment (what systemd will start it with), one key.
unit_env() { systemctl show -P Environment sahale | tr ' ' '\n' | sed -n "s/^$1=//p" | head -n 1; }

health() { curl -s -m 5 "http://127.0.0.1:$PORT/api/runtime/health" || true; }
wait_ready() { local i; for ((i = 0; i < READY_TIMEOUT; i++)); do [[ $(health) == '{"ok":true,"db":"ready"}' ]] && return 0; sleep 1; done; return 1; }
runtime_version() { curl -s -m 5 "http://127.0.0.1:$PORT/api/runtime" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version"))' 2>/dev/null || echo none; }
source_version() { sed -n "s/^export const VERSION = '\(.*\)'$/\1/p" "$1/server/routes/runtime.ts"; }

# The startup banner since <t0>. It can reach the journal a moment after health answers, so wait for it.
banner_since() {
  local b='' i
  for ((i = 0; i < 30; i++)); do
    b=$(journalctl -u sahale --since "@$1" --no-pager -o cat)
    grep -q '^ *database ' <<<"$b" && break
    sleep 1
  done
  printf '%s\n' "$b"
}

in_window() { local now=$((10#$(date +%H%M))) a=$((10#${QUIET_WINDOW%-*})) b=$((10#${QUIET_WINDOW#*-})); ((a < b && now >= a && now <= b)); }
# Never next to the nightly snapshot or the Restic jobs.
quiet() {
  ! in_window || fail "inside the nightly backup window ($QUIET_WINDOW); run later"
  ok "outside the $QUIET_WINDOW backup window ($(date +%H:%M))"
  local u st
  for u in sahale-snapshot.service "$RESTIC_LOCAL_UNIT" "$RESTIC_B2_UNIT"; do
    st=$(systemctl show -P ActiveState "$u")
    [[ $st == inactive || $st == failed ]] || fail "$u is $st"
  done
  ok "snapshot and Restic units idle"
  if pgrep -x restic >/dev/null; then fail "a restic process is running"; fi
  ok "no restic process"
}

# env_access: the public origin and owner login the runtime is configured with. Sets PUBLIC and OWNER.
env_access() {
  local origin; origin=$(kv "$ENVFILE" SAHALE_PUBLIC_ORIGIN)
  [[ $origin =~ ^https://([a-z0-9.-]+:[0-9]+)$ ]] || fail "SAHALE_PUBLIC_ORIGIN in $ENVFILE is not https://<host>:<port>"
  PUBLIC=${BASH_REMATCH[1]}
  OWNER=$(kv "$ENVFILE" SAHALE_OWNER_LOGIN)
  [[ -n $OWNER ]] || fail "no owner login in $ENVFILE"
  ok "public origin and owner login configured (not shown)"
}

serve_now() { tailscale serve status 2>&1; }
serve_expected() {
  local s; s=$(serve_now)
  [[ $s == *"https://$PUBLIC (tailnet only)"* && $s == *"proxy http://127.0.0.1:$PORT"* && $s != *[Ff]unnel\ on* ]] || fail "unexpected Serve config (not shown in full)"
  ok "Serve: the public origin, tailnet only -> 127.0.0.1:$PORT"
}

# unit_state: what must not change across a release: installed unit files, drop-ins, timer state.
unit_state() {
  local f
  for f in $UNIT_FILES; do printf '%s %s\n' "$f" "$(sha "$UNITS/$f")"; done
  printf 'dropins sahale: %s\n' "$(systemctl show -P DropInPaths sahale)"
  printf 'dropins sahale-snapshot: %s\n' "$(systemctl show -P DropInPaths sahale-snapshot)"
  printf 'timer %s %s\n' "$(systemctl is-active sahale-snapshot.timer || true)" "$(systemctl is-enabled sahale-snapshot.timer || true)"
}
failed_units() { systemctl --failed --plain --no-legend | awk '{print $1}' | paste -sd' ' -; }

tree_at() { # tree_at <dir> <commit> <label>
  expect "$3 commit" "$2" "$(as_admin git -C "$1" rev-parse HEAD)"
  expect "$3 working tree clean" "" "$(as_admin git -C "$1" status --porcelain)"
  expect "$3 owner" "$ADMIN" "$(stat -c %U "$1")"
}

# Gates on a check report: integrity, foreign keys, the expected migrations line.
gate_report() { # gate_report <file> <migrations line> <label>
  grep -qx 'integrity        ok' "$1" || fail "$3: integrity not ok"
  grep -qx 'foreign keys     ok' "$1" || fail "$3: foreign keys not ok"
  grep -qx "$2" "$1" || fail "$3: $(grep '^migrations' "$1" | tr -s ' '), expected ${2//  / }"
  ok "$3: integrity ok, foreign keys ok, $(grep '^migrations' "$1" | tr -s ' ')"
}
no_active() { expect "$2: workouts in progress" "active workouts  0" "$(grep '^active workouts' "$1")"; }

# A consistent copy of the live database for reading (the online backup API); the caller removes it.
live_copy() { local v=$DATA/verify-release.db; sqlite_tool snapshot "$DB" "$v" >/dev/null; echo "$v"; }

stop_sahale() {
  systemctl stop sahale
  expect "sahale" inactive "$(systemctl is-active sahale || true)"
  [[ -z $(pgrep -u sahale || true) ]] || fail "processes still running as sahale"
  ok "no sahale processes"
  local wal; wal=$(stat -c %s "$DB-wal" 2>/dev/null || echo absent)
  [[ $wal == absent || $wal == 0 ]] || fail "-wal is $wal bytes after stop: not closed cleanly"
  ok "database closed cleanly (-wal $wal)"
}

# fingerprint <db>: one line per table — "<table> <rows> <sha256 of every row, in rowid order>" — for every
# table except the migration bookkeeping. Equal fingerprints mean equal contents, edits included (a check
# report only counts rows). Opens the file read-only.
fingerprint() {
  "${PY[@]}" - "$1" <<'PY'
import hashlib, sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name")]
for t in tables:
    h, n = hashlib.sha256(), 0
    for row in db.execute(f'SELECT * FROM "{t}" ORDER BY rowid'):
        h.update(repr(row).encode())
        n += 1
    print(t, n, h.hexdigest())
PY
}

# ---- HTTP checks: requests as Tailscale Serve forwards them (Host + identity), sent straight to loopback.
# The caller sets U (loopback base URL), PUBLIC and OWNER. Nothing here creates a record.
code() { curl -s -o /dev/null -w '%{http_code}' -m 5 "$@"; }
errcode() { curl -s -m 5 "$@" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("code"))' 2>/dev/null || echo none; }
access_fitness() {
  local H=(-H "Host: $PUBLIC") ID=(-H "Tailscale-User-Login: $OWNER")
  expect "owner, history page" 200 "$(code "${H[@]}" "${ID[@]}" "$U/history")"
  expect "owner, API" 200 "$(code "${H[@]}" "${ID[@]}" "$U/api/fitness")"
  expect "no identity" forbidden_identity "$(errcode "${H[@]}" "$U/api/fitness")"
  expect "other tailnet identity" forbidden_identity "$(errcode "${H[@]}" -H 'Tailscale-User-Login: someone-else@example.com' "$U/api/fitness")"
  expect "funnel-marked request" forbidden_identity "$(errcode "${H[@]}" "${ID[@]}" -H 'Tailscale-Funnel-Request: ?1' "$U/api/fitness")"
  expect "default :443 host" forbidden_host "$(errcode -H "Host: ${PUBLIC%:*}" "${ID[@]}" "$U/api/fitness")"
  expect "foreign origin write" forbidden_origin "$(errcode -X POST "${H[@]}" "${ID[@]}" -H 'Origin: https://evil.example' -H 'x-sahale-client: 1' -H 'content-type: application/json' -d '{"op":"skip"}' "$U/api/fitness/sessions/s_none/rest")"
}
