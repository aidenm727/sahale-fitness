#!/bin/bash
# Sahale CP3 overnight check, host side: last night's snapshot and both Restic jobs ran and hold tonight's copy.
# Read-only on production and on the repositories (--no-lock). Run each morning after the backup window:
#
#   sudo bash /opt/sahale/app/deploy/cp3.sh overnight
#
# It replaces the per-version kit copies (cp3-v012.sh, cp3-v020.sh, …): the commit and the migration count it
# expects come from /opt/sahale/DEPLOYED, written by deploy/release (or, before the first such release, from
# git rev-parse in /opt/sahale/app and that tree's migration journal). Host values (Restic units, scripts,
# repositories, stamps, slots, log folder) come from /etc/sahale/release.conf. A pass today is the gate
# deploy/release checks. Credentials stay where the jobs keep them: read by restic from the same files, never printed.
# --root <dir> runs against a fake host (deploy/release.test.sh).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=release-lib.sh
source "$HERE/release-lib.sh"
STAGE=${1:-}
ROOT=''
if [[ ${2:-} == --root ]]; then ROOT=${3:-}; fi
[[ $STAGE == overnight ]] || { echo "usage: sudo bash $0 overnight" >&2; exit 2; }
host_paths
check_root ''
cd /
umask 077
load_conf RESTIC_LOCAL_UNIT RESTIC_B2_UNIT RESTIC_LOCAL_SCRIPT RESTIC_B2_SCRIPT RESTIC_LOCAL_REPO RESTIC_B2_REPO RESTIC_B2_ENV \
  RESTIC_LOCAL_STAMP RESTIC_B2_STAMP BACKUPS_JSON SLOT_SNAPSHOT SLOT_LOCAL SLOT_B2 CP3_OUT
mkdir -p "$CP3_OUT"
LOG=$CP3_OUT/cp3-$STAGE-$(date +%Y%m%d-%H%M%S).log
exec > >(tee -a "$LOG") 2>&1
[[ -z $ROOT ]] && trap 'chown -R "$ADMIN:$ADMIN" "$CP3_OUT"' EXIT
TOOL=$APP/deploy/sahale-sqlite.py

unit_time() { local t; t=$(systemctl show --timestamp=unix -P "$2" "$1"); [[ $t == @* ]] && date -d "$t" '+%F %H:%M:%S' || echo never; }

# The password files the jobs use, read from the scripts themselves; never printed.
load_repos() {
  local re='s/^PASSWORD_FILE="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p'
  LOCAL_PW=$(sed -n "$re" "$RESTIC_LOCAL_SCRIPT"); B2_PW=$(sed -n "$re" "$RESTIC_B2_SCRIPT")
  [[ -n $LOCAL_PW && $LOCAL_PW != *$'\n'* && -f $LOCAL_PW ]] || fail "password file of $RESTIC_LOCAL_SCRIPT not found"
  [[ -n $B2_PW && $B2_PW != *$'\n'* && -f $B2_PW ]] || fail "password file of $RESTIC_B2_SCRIPT not found"
  [[ -f $RESTIC_B2_ENV ]] || fail "B2 credentials file missing"
  ok "repository credentials present (not shown)"
}
# Read-only repository access, as root like the jobs (the local repository has root-owned files).
r_local() { restic -r "$RESTIC_LOCAL_REPO" --password-file "$LOCAL_PW" --no-lock "$@"; }
r_b2() { ( . "$RESTIC_B2_ENV"; export B2_ACCOUNT_ID B2_ACCOUNT_KEY; restic -r "$RESTIC_B2_REPO" --password-file "$B2_PW" --no-lock "$@" ); }

# stdin: `restic snapshots --json`. sahale_snaps: "<id> <time> ok" per Sahale snapshot, oldest first.
SNAPS_PY='
import json, sys
snap = sys.argv[1]
rows = json.load(sys.stdin) or []
for s in sorted(rows, key=lambda s: s["time"]):
    if "sahale" in (s.get("tags") or []):
        good = s["paths"] == [snap] and s["tags"] == ["sahale"]
        print(s["id"], s["time"][:19], "ok" if good else "unexpected:" + ",".join(s["paths"]) + "/" + ",".join(s["tags"]))
'
# The repositories record the real path, also on a fake host.
sahale_snaps() { python3 -c "$SNAPS_PY" "/var/lib/sahale/snapshots/sahale-latest.db"; }

step "deployed (expected commit and schema)"
COMMIT_GIT=$(as_admin git -C "$APP" rev-parse HEAD)
if [[ -f $DEPLOYED_FILE ]]; then
  COMMIT=$(kv "$DEPLOYED_FILE" commit); N=$(kv "$DEPLOYED_FILE" migrations); LAST=$(kv "$DEPLOYED_FILE" migrations_last)
  ok "expected from $DEPLOYED_FILE: $(kv "$DEPLOYED_FILE" tag) ${COMMIT:0:12}, $N migrations"
else
  COMMIT=$COMMIT_GIT
  line=$(journal_line "$APP/server/db/migrations/meta/_journal.json")
  N=$(sed -n 's/^migrations *\([0-9]*\) applied, .*/\1/p' <<<"$line"); LAST=${line##*last }
  note "no $DEPLOYED_FILE: expected commit from git (${COMMIT:0:12}), $N migrations from its journal"
fi
[[ $COMMIT =~ ^[0-9a-f]{40}$ && $N =~ ^[0-9]+$ && -n $LAST ]] || fail "cannot tell the expected commit and migration count"
MIG="migrations       $N applied, last $LAST"
expect "deployed commit" "$COMMIT" "$COMMIT_GIT"
expect "working tree clean" "" "$(as_admin git -C "$APP" status --porcelain)"

# check report gates: integrity, foreign keys, the deployed migrations, at least one owner session listed.
check_report() {
  python3 "$TOOL" check "$1" > "$2" || fail "check failed on $1"
  grep -qx 'integrity        ok' "$2" || fail "integrity not ok: $1"
  grep -qx 'foreign keys     ok' "$2" || fail "foreign keys not ok: $1"
  grep -qx "$MIG" "$2" || fail "unexpected $(grep '^migrations' "$2" | tr -s ' '), expected $N"
  grep -q '^session  ' "$2" || fail "no owner session listed: $1"
  ok "check: integrity ok, foreign keys ok, $N migrations as deployed, $(grep -c '^session ' "$2") recent sessions, $(grep '^active workouts' "$2" | tr -s ' ')"
}

step "overnight runs (read-only)"
quiet
load_repos
today=$(date +%F)
for u in "sahale-snapshot.service:$SLOT_SNAPSHOT" "$RESTIC_LOCAL_UNIT:$SLOT_LOCAL" "$RESTIC_B2_UNIT:$SLOT_B2"; do
  want=${u##*:}; u=${u%:*}
  expect "$u Result" success "$(systemctl show -P Result "$u")"
  t=$(systemctl show --timestamp=unix -P ExecMainStartTimestamp "$u")
  [[ $t == @* && $(date -d "$t" +%F) == "$today" ]] || fail "$u has not run today (last $(unit_time "$u" ExecMainStartTimestamp))"
  hm=$((10#$(date -d "$t" +%H%M)))
  ((hm >= 10#$want && hm < 10#$want + 100)) || fail "$u ran at $(date -d "$t" +%H:%M), not the nightly slot"
  ok "$u ran $(date -d "$t" '+%F %H:%M:%S')"
done
for t in "$RESTIC_LOCAL_STAMP" "$RESTIC_B2_STAMP"; do
  [[ $(date -d "$(cat "$t")" +%F) == "$today" ]] || fail "$(basename "$t") is $(cat "$t")"
  ok "$(basename "$t") $(cat "$t")"
done
s0=$(sha "$SNAP")
check_report "$SNAP" "$CP3_OUT/overnight-check.txt"
for label in local b2; do
  if [[ $label == local ]]; then reader=r_local; else reader=r_b2; fi
  rows=$("$reader" snapshots --json | sahale_snaps) || fail "cannot read the $label repository"
  last=$(tail -n 1 <<<"$rows")
  [[ $last == *" ${today}T"*" ok" ]] || fail "no Sahale snapshot from tonight in $label (latest: $last)"
  ok "$label: $(grep -c . <<<"$rows") Sahale snapshots, latest ${last:0:8} ${last:65:19}"
  dumped=$("$reader" dump latest --tag sahale /var/lib/sahale/snapshots/sahale-latest.db | sha256sum | cut -d' ' -f1) || fail "restic dump from $label failed"
  expect "$label latest Sahale snapshot = current file (sha256 via restic dump)" "$s0" "$dumped"
done
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); [print("  backups.json %-5s %s fresh=%s" % (k, d[k]["last_success"], d[k]["fresh"])) or (d[k]["fresh"] or sys.exit(1)) for k in ("local","b2")]' "$BACKUPS_JSON" \
  || fail "backups.json reports a stale backup"
expect "sahale" active "$(systemctl is-active sahale)"
expect "failed units" "" "$(failed_units)"
printf '\n%s: %d checks passed. Log: %s\n' "$STAGE" "$PASS" "$LOG"
