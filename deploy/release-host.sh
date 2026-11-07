#!/bin/bash
# Sahale release, host side: run by deploy/release and deploy/rollback on the laptop, never by hand.
# Code-only releases (the tag's migrations equal the deployed ones). One sudo session per run:
#
#   sudo bash ~/sahale-release/<tag>/release-host.sh release  <tag> <commit> <SHA256SUMS sha> --admin <user>
#   sudo bash ~/sahale-release/rollback-<tag>/release-host.sh rollback <tag> <commit> <SHA256SUMS sha> --admin <user>
#   bash release-host.sh plan release|rollback <tag> <commit> <sums> --admin <user>   (prints the steps, touches nothing)
#
# release:  preflight (kit, deployed tree, service, Serve, units, window, today's cp3 overnight, ancestry,
#           migrations identical, live database) -> stage beside production as <admin> (npm ci, build, test)
#           -> online snapshot + check -> switch (stop, mv, start, checks; any failed check swaps back and
#           restarts the previous tree) -> record /opt/sahale/DEPLOYED and releases.log.
# rollback: the same preflight, then switch to a kept (or re-staged) tree of an earlier tag, only when the live
#           database's migrations equal that tag's. Every other case is refused.
#
# --root <dir> runs against a fake host (a directory holding a FAKE-HOST marker), for deploy/release.test.sh.
set -euo pipefail

KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
usage() {
  echo "usage: sudo bash $0 release|rollback <tag> <commit> <sums sha256> --admin <user> [--root <fake host>]" >&2
  echo "       bash $0 plan release|rollback <tag> <commit> <sums sha256> --admin <user>" >&2
  exit 2
}
MODE=${1:-}; shift || usage
PLAN=0
if [[ $MODE == plan ]]; then PLAN=1; MODE=${1:-}; shift || usage; fi
[[ $MODE == release || $MODE == rollback ]] || usage
(($# >= 3)) || usage
TAG=$1 COMMIT=$2 SUMS=$3; shift 3
ADMIN_ARG='' ROOT=''
while (($#)); do
  case $1 in
    --admin) ADMIN_ARG=${2:-}; shift 2 || usage ;;
    --root) ROOT=${2:-}; shift 2 || usage ;;
    *) usage ;;
  esac
done
[[ $TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a release tag: $TAG" >&2; exit 2; }
[[ $COMMIT =~ ^[0-9a-f]{40}$ && $SUMS =~ ^[0-9a-f]{64}$ ]] || usage
[[ $ADMIN_ARG =~ ^[a-z_][a-z0-9_-]*$ || ($PLAN == 1 && $ADMIN_ARG == "<admin>") ]] || usage

BUNDLE=$KIT/$TAG.bundle
TOOL=$KIT/sahale-sqlite.py

# ---- plan: what a run does on the host, in order, with the real paths. Runs anywhere; touches nothing.
if [[ $PLAN == 1 ]]; then
  # shellcheck source=release-lib.sh
  source "$KIT/release-lib.sh"
  host_paths
  if [[ $MODE == release ]]; then K="~$ADMIN_ARG/sahale-release/$TAG"; else K="~$ADMIN_ARG/sahale-release/rollback-$TAG"; fi
  cat <<EOF
  [kit]       sha256sum SHA256SUMS = ${SUMS:0:16}…; sha256sum -c SHA256SUMS            (in $K)
              runuser -u $ADMIN_ARG -- git clone --bare $K/$TAG.bundle $K/check.XXXXXX/repo.git
              git rev-parse $TAG^{commit} = ${COMMIT:0:12}
  [read]      $DEPLOYED_FILE (absent on the first run), git -C $APP rev-parse HEAD / status --porcelain
              systemctl show -P Environment sahale (port, data dir); systemctl is-active / is-enabled sahale
              curl http://127.0.0.1:<port>/api/runtime/health and /api/runtime (version = deployed source)
              $ENVFILE (origin, owner; not printed); tailscale serve status (read only, saved for comparison)
              $CONF; outside \$QUIET_WINDOW; systemctl show -P ActiveState sahale-snapshot + Restic units; pgrep -x restic
              newest cp3-overnight-*.log in \$CP3_GATE_DIRS: from today and passed
              sha256 $UNITS/{$(echo "$UNIT_FILES" | tr ' ' ',')} = $TAG's deploy/ files; DropInPaths sahale empty
              $NODEBIN/node -v matches $TAG's .nvmrc
              runuser -u sahale -- python3 - check $DB  (sahale-sqlite.py on stdin): integrity, FKs, migrations = $TAG's journal, active workouts 0
EOF
  if [[ $MODE == release ]]; then
    cat <<EOF
  [refuse]    $TAG == deployed; deployed not an ancestor of $TAG; server/db/migrations differs from the deployed
              tree; a unit file differs from the installed one; $OPT/app-$TAG present but not a clean ${COMMIT:0:7}
  [stage]     runuser -u $ADMIN_ARG -- git clone --branch $TAG $K/$TAG.bundle $OPT/app-$TAG
              (in $OPT/app-$TAG, as $ADMIN_ARG, PATH=$NODEBIN:…) npm ci; npm run build; npm test; git status --porcelain empty
EOF
  else
    cat <<EOF
  [refuse]    $TAG == deployed; live migrations != $TAG's journal (more: restore path not supported; fewer: a
              release, not a rollback); a unit file differs from the installed one
  [target]    a clean $OPT/app-* at ${COMMIT:0:7} (kept by the release that replaced it), else
              runuser -u $ADMIN_ARG -- git clone --branch $TAG $K/$TAG.bundle $OPT/app-$TAG; npm ci; npm run build
EOF
  fi
  cat <<EOF
  [snapshot]  runuser -u sahale -- mkdir -p -m 0700 $BACKUPS
              runuser -u sahale -- python3 - snapshot $DB $BACKUPS/sahale-<UTC>-before-$TAG.db
              runuser -u sahale -- python3 - check <that file>: integrity, FKs, migrations, active workouts 0; sha256 recorded
  [switch]    window and jobs idle again; systemctl stop sahale; inactive, no sahale processes, -wal empty
              check + fingerprint of the stopped database = the snapshot's (else start the old tree, stop: nothing switched)
              mv $APP $OPT/app-<deployed tag or short commit>
              mv <new tree> $APP
              systemctl start sahale; health {"ok":true,"db":"ready"} within \$READY_TIMEOUT s
              journalctl -u sahale --since @<t0>: "database   ready" (nothing applied)
              /api/runtime version = the new tree's; live copy (runuser -u sahale -- python3 - snapshot $DB $DATA/verify-release.db):
              check report and content fingerprint = the stopped database's; rm $DATA/verify-release.db
              owner-only matrix (curl to 127.0.0.1 with the Host and identity Serve sends; no records created)
              tailscale serve status = before; unit hashes, drop-ins, timer = before; systemctl --failed empty
  [swap-back] on any failed check after the first mv: systemctl stop sahale; mv $APP $OPT/app-$TAG-failed-<UTC>;
              mv $OPT/app-<previous> $APP; systemctl start sahale; health ready; version and data = before;
              releases.log gets a "swapped-back" line; exit 1
  [record]    runuser -u $ADMIN_ARG: write $DEPLOYED_FILE (tag, commit, version, migrations, snapshot + sha256, previous, kept)
              append one line to $RELEASES_LOG
EOF
  exit 0
fi

# ---- the kit on disk is exactly what the laptop built and sent (its SHA256SUMS digest came over ssh).
[[ $(sha256sum "$KIT/SHA256SUMS" | cut -d' ' -f1) == "$SUMS" ]] || { echo "SHA256SUMS in $KIT is not the one the laptop sent" >&2; exit 1; }
(cd "$KIT" && sha256sum -c --quiet SHA256SUMS) || { echo "kit files in $KIT do not match SHA256SUMS" >&2; exit 1; }
for f in release-host.sh release-lib.sh sahale-sqlite.py "$TAG.bundle"; do
  grep -q "  $f\$" "$KIT/SHA256SUMS" || { echo "SHA256SUMS does not cover $f" >&2; exit 1; }
done
# shellcheck source=release-lib.sh
source "$KIT/release-lib.sh"
host_paths
check_root "$ADMIN_ARG"
cd /
umask 077
LOG=$KIT/$MODE-$(stamp).log
exec > >(tee -a "$LOG") 2>&1
CHECK=''
# An unexpected error (set -e) while the new tree is in place swaps back too.
on_exit() {
  local rc=$?
  if [[ $SWITCHED == 1 && $IN_SWAPBACK == 0 ]]; then
    printf '  FAIL unexpected exit (status %s) during the switch\n' "$rc"
    swap_back
    rc=1
  fi
  [[ -n $CHECK && $CHECK == "$KIT"/check.* ]] && rm -rf -- "$CHECK"
  [[ -z $ROOT ]] && chown -R "$ADMIN:$ADMIN" "$KIT"
  exit "$rc"
}
trap on_exit EXIT
trap 'fail "interrupted"' INT TERM
printf '%s %s %s (%s), kit %s\n' "$(utc)" "$MODE" "$TAG" "${COMMIT:0:12}" "$KIT"
ok "kit matches SHA256SUMS, and SHA256SUMS is the one the laptop sent"

in_tree() { # in_tree <dir> <command>: as the admin, in that tree, with the pinned Node first on PATH
  as_admin env HOME="$ADMIN_HOME" PATH="$NODEBIN:$PATH" NO_COLOR=1 FORCE_COLOR=0 bash -c 'cd "$1" && umask 022 && eval "$2"' _ "$1" "$2"
}
at_tag() { as_admin git -C "$REPO" show "$COMMIT:$1"; }
mig_line() { sed -n 's/^\(migrations .*\)$/\1/p' "$1"; }

overnight_passed() {
  local d log best=''
  for d in $CP3_GATE_DIRS; do
    for log in "$d"/cp3-overnight-*.log; do
      [[ -f $log ]] || continue
      if [[ -z $best || $log -nt $best ]]; then best=$log; fi
    done
  done
  [[ -n $best ]] || fail "no cp3 overnight run on record in $CP3_GATE_DIRS: run 'sudo bash $APP/deploy/cp3.sh overnight' (or the kit's cp3) after the backup window"
  [[ $(date -r "$best" +%F) == "$(date +%F)" ]] || fail "the latest cp3 overnight run is not from today ($(basename "$best")): run it this morning"
  grep -qE '^overnight: [0-9]+ checks passed\.' "$best" || fail "today's cp3 overnight run did not pass: $best"
  ok "last night's backups verified this morning ($(basename "$best"): $(grep -oE '^overnight: [0-9]+ checks passed' "$best"))"
}

build_tree() { # build_tree <dir> test|notest
  step "npm ci (lockfile-pinned)"
  in_tree "$1" 'npm ci' > "$KIT/stage-npm-ci.log" 2>&1 || { tail -n 20 "$KIT/stage-npm-ci.log" | indent; fail "npm ci failed"; }
  ok "npm ci"
  step "npm run build"
  in_tree "$1" 'npm run build' > "$KIT/stage-build.log" 2>&1 || { tail -n 20 "$KIT/stage-build.log" | indent; fail "build failed"; }
  [[ -f $1/dist/index.html ]] || fail "no dist/index.html"
  ok "built"
  if [[ $2 == test ]]; then
    step "npm test"
    local tests
    tests=$(in_tree "$1" 'npm test' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tee "$KIT/stage-test.log" | grep -E '^ +Tests ' | tr -s ' ' || true)
    if ! grep -qE '^ +Tests +[0-9]+ passed' <<<"$tests" || grep -q failed <<<"$tests"; then
      tail -n 30 "$KIT/stage-test.log" | indent
      fail "tests did not pass"
    fi
    ok "tests:$tests"
  fi
  expect "working tree clean after the build" "" "$(as_admin git -C "$1" status --porcelain)"
}

# ---- preflight: production as deployed
step "the kit's tag"
CHECK=$(as_admin mktemp -d "$KIT/check.XXXXXX")
REPO=$CHECK/repo.git
as_admin git clone --quiet --bare "$BUNDLE" "$REPO"
expect "bundle: $TAG" "$COMMIT" "$(as_admin git -C "$REPO" rev-parse "$TAG^{commit}")"

step "production as deployed"
[[ -d $APP ]] || fail "$APP missing"
DEP_COMMIT=$(as_admin git -C "$APP" rev-parse HEAD)
DEP_TAG=''
if [[ -f $DEPLOYED_FILE ]]; then
  expect "DEPLOYED record matches the deployed tree" "$(kv "$DEPLOYED_FILE" commit)" "$DEP_COMMIT"
  DEP_TAG=$(kv "$DEPLOYED_FILE" tag)
else
  note "no $DEPLOYED_FILE yet (first run with this tool): the deployed commit comes from git"
fi
tree_at "$APP" "$DEP_COMMIT" "deployed"
DEP_VERSION=$(source_version "$APP")
PORT=$(unit_env SAHALE_PORT)
[[ $PORT =~ ^[0-9]+$ ]] || fail "no SAHALE_PORT in the sahale unit's environment"
expect "unit data dir" "$DATA" "$(unit_env SAHALE_DATA_DIR)"
U=http://127.0.0.1:$PORT
load_conf RESTIC_LOCAL_UNIT RESTIC_B2_UNIT CP3_GATE_DIRS
expect "sahale" "active enabled" "$(systemctl is-active sahale || true) $(systemctl is-enabled sahale || true)"
expect "health" '{"ok":true,"db":"ready"}' "$(health)"
expect "running version = the deployed tree's" "$DEP_VERSION" "$(runtime_version)"
env_access
serve_expected
serve_now > "$KIT/serve-before.txt"
unit_state > "$KIT/units-before.txt"
expect "sahale drop-ins" "" "$(systemctl show -P DropInPaths sahale)"
expect "failed units" "" "$(failed_units)"

step "release window"
quiet
overnight_passed

step "$TAG against production"
[[ $DEP_COMMIT != "$COMMIT" ]] || fail "$TAG (${COMMIT:0:7}) is already deployed"
EXPECT_MIG=$(journal_line <(at_tag server/db/migrations/meta/_journal.json))
check_db "$DB" > "$KIT/preflight-live.check"
LIVE_MIG=$(mig_line "$KIT/preflight-live.check")
same_migrations() { [[ $(as_admin git -C "$REPO" rev-parse "$COMMIT:server/db/migrations") == $(as_admin git -C "$APP" rev-parse "HEAD:server/db/migrations") ]]; }
if [[ $MODE == release ]]; then
  as_admin git -C "$REPO" merge-base --is-ancestor "$DEP_COMMIT" "$COMMIT" 2>/dev/null \
    || fail "the deployed commit ${DEP_COMMIT:0:7} is not an ancestor of $TAG: refusing (releasing it would drop deployed changes)"
  ok "deployed ${DEP_COMMIT:0:7} is an ancestor of $TAG"
  if ! same_migrations; then
    as_admin git -C "$REPO" diff --name-status "$DEP_COMMIT" "$COMMIT" -- server/db/migrations | indent
    fail "$TAG changes server/db/migrations (above): this tool releases code only (migration releases wait, report 005 §5)"
  fi
  ok "server/db/migrations identical to the deployed tree's: code only"
else
  if [[ $LIVE_MIG != "$EXPECT_MIG" ]]; then
    live_n=$(sed -n 's/^migrations *\([0-9]*\) .*/\1/p' <<<"$LIVE_MIG"); want_n=$(sed -n 's/^migrations *\([0-9]*\) .*/\1/p' <<<"$EXPECT_MIG")
    if ((live_n > want_n)); then
      fail "the live database has $live_n migrations, $TAG knows $want_n: rolling back across a migration needs the restore path, which this tool refuses (report 005 §5)"
    elif ((live_n < want_n)); then
      fail "$TAG has $want_n migrations, the live database $live_n: that is a release with migrations, not a rollback"
    fi
    fail "the live database's migrations ($LIVE_MIG) differ from $TAG's ($EXPECT_MIG)"
  fi
  same_migrations || fail "$TAG's server/db/migrations differs from the deployed tree's: not a code-only rollback"
  ok "$TAG's migrations equal the live database's and the deployed tree's: code only"
fi
gate_report "$KIT/preflight-live.check" "$EXPECT_MIG" "live database"
no_active "$KIT/preflight-live.check" "live database"
for f in $UNIT_FILES; do
  [[ $(at_tag "deploy/$f" | sha256sum | cut -d' ' -f1) == $(sha "$UNITS/$f") ]] \
    || fail "$TAG's deploy/$f differs from the installed $UNITS/$f: a unit-file change is a separate, manual step"
done
ok "$TAG's unit files = the installed ones"
want_node=$(at_tag .nvmrc | tr -d '[:space:]')
have_node=$("$NODEBIN/node" -v)
[[ $have_node == "v$want_node" || $have_node == "v$want_node".* ]] || fail "node is $have_node, $TAG's .nvmrc wants $want_node"
ok "node $have_node matches $TAG's .nvmrc ($want_node)"

KEPT=$OPT/app-${DEP_TAG:-${DEP_COMMIT:0:7}}
if [[ $MODE == rollback && -e $KEPT ]]; then KEPT=$KEPT-$(stamp); fi
[[ ! -e $KEPT ]] || fail "$KEPT already exists (the deployed tree goes there): move it aside"
ok "the deployed tree will be kept as $KEPT"

# ---- the new tree
if [[ $MODE == release ]]; then
  step "stage $TAG beside production (production keeps running)"
  NEW=$OPT/app-$TAG
  if [[ -e $NEW ]]; then
    [[ $(as_admin git -C "$NEW" rev-parse HEAD 2>/dev/null) == "$COMMIT" && -z $(as_admin git -C "$NEW" status --porcelain) ]] \
      || fail "$NEW exists and is not a clean ${COMMIT:0:7} tree: inspect and move it aside"
    ok "$NEW already at ${COMMIT:0:7}; building it again"
  else
    as_admin bash -c 'umask 022 && git -c advice.detachedHead=false clone --quiet --branch "$1" "$2" "$3"' _ "$TAG" "$BUNDLE" "$NEW"
    ok "cloned into $NEW"
  fi
  tree_at "$NEW" "$COMMIT" "staged"
  build_tree "$NEW" test
else
  step "the $TAG tree"
  NEW=''
  for d in "$OPT/app-$TAG" "$OPT"/app-*; do
    [[ -d $d && $d != "$APP" ]] || continue
    if [[ $(as_admin git -C "$d" rev-parse HEAD 2>/dev/null) == "$COMMIT" ]]; then NEW=$d; break; fi
  done
  if [[ -n $NEW ]]; then
    tree_at "$NEW" "$COMMIT" "kept"
    if [[ -f $NEW/dist/index.html && -d $NEW/node_modules ]]; then ok "$NEW is built"; else build_tree "$NEW" notest; fi
  else
    NEW=$OPT/app-$TAG
    [[ ! -e $NEW ]] || fail "$NEW exists and is not at ${COMMIT:0:7}: inspect and move it aside"
    note "no kept tree at ${COMMIT:0:7}: staging it again from the bundle (tests were run when $TAG was released)"
    as_admin bash -c 'umask 022 && git -c advice.detachedHead=false clone --quiet --branch "$1" "$2" "$3"' _ "$TAG" "$BUNDLE" "$NEW"
    tree_at "$NEW" "$COMMIT" "staged"
    build_tree "$NEW" notest
  fi
fi
NEW_VERSION=$(source_version "$NEW")
[[ $MODE == rollback || $NEW_VERSION == "${TAG#v}" ]] || fail "$NEW reports version $NEW_VERSION, not ${TAG#v}"

# ---- snapshot
step "online snapshot before the switch"
as_sahale mkdir -p -m 0700 "$BACKUPS"
SNAPSHOT=$BACKUPS/sahale-$(stamp)-before-$TAG.db
sqlite_tool snapshot "$DB" "$SNAPSHOT" | indent
check_db "$SNAPSHOT" > "$KIT/snapshot.check"
gate_report "$KIT/snapshot.check" "$EXPECT_MIG" "snapshot"
no_active "$KIT/snapshot.check" "snapshot"
SNAPSHOT_SHA=$(sha "$SNAPSHOT")
ok "snapshot $SNAPSHOT (sha256 ${SNAPSHOT_SHA:0:16}…)"

# ---- switch, with automatic swap-back
OLD_VERSION=$DEP_VERSION
swap_back() {
  IN_SWAPBACK=1
  SWITCHED=0
  step "swap back to ${DEP_COMMIT:0:7}"
  local b failed
  b=$(journalctl -u sahale --since "@$T0" --no-pager -o cat 2>/dev/null || true)
  if grep -q 'database .*applied ' <<<"$b"; then
    fail "the new tree applied a migration ($(grep -o 'applied .*' <<<"$b" | head -n 1)); not swapping back automatically"
  fi
  systemctl stop sahale || true
  expect "sahale" inactive "$(systemctl is-active sahale || true)"
  if [[ -d $APP && $(as_admin git -C "$APP" rev-parse HEAD 2>/dev/null) != "$DEP_COMMIT" ]]; then
    failed=$OPT/app-$TAG-failed-$(stamp)
    mv "$APP" "$failed"
    ok "the failed tree kept as $failed"
  fi
  if [[ ! -e $APP ]]; then mv "$KEPT" "$APP"; fi
  tree_at "$APP" "$DEP_COMMIT" "back in place"
  systemctl start sahale
  wait_ready || fail "${DEP_COMMIT:0:7} is not ready after the swap-back"
  expect "running version" "$OLD_VERSION" "$(runtime_version)"
  if [[ -f $KIT/stopped.check ]]; then
    local v; v=$(live_copy)
    check_db "$v" > "$KIT/swapped-back.check"; rm -f "$v"
    cmp -s "$KIT/stopped.check" "$KIT/swapped-back.check" || fail "the database after the swap-back differs from before the switch"
    ok "database as it was before the switch"
  fi
  as_admin bash -c 'umask 022 && printf "%s\n" "$2" >> "$1"' _ "$RELEASES_LOG" \
    "$(utc) $MODE $TAG $COMMIT result=swapped-back running=${DEP_TAG:-${DEP_COMMIT:0:7}} snapshot=$SNAPSHOT"
  IN_SWAPBACK=0
  printf '\nSWAPPED BACK: %s is running again; %s was not accepted (FAIL above). Log: %s\n' "${DEP_TAG:-${DEP_COMMIT:0:7}}" "$TAG" "$LOG"
}

step "switch: ${DEP_TAG:-${DEP_COMMIT:0:7}} -> $TAG"
quiet
T0=$(date +%s)
rm -f "$KIT/stopped.check"
SWITCHED=1   # from here every failure restarts ${DEP_COMMIT:0:7} (swap_back)
stop_sahale
check_db "$DB" > "$KIT/stopped.check"
fingerprint "$DB" > "$KIT/stopped.fingerprint"
if ! cmp -s "$KIT/snapshot.check" "$KIT/stopped.check"; then
  diff "$KIT/snapshot.check" "$KIT/stopped.check" | indent || true
  fail "the database changed after the snapshot (above): nothing switched. Run again."
fi
ok "stopped database = the snapshot (report)"
mv "$APP" "$KEPT"
mv "$NEW" "$APP"
tree_at "$APP" "$COMMIT" "in place"
systemctl start sahale
if ! wait_ready; then
  journalctl -u sahale --since "@$T0" --no-pager -o cat | grep -vE '^ *private ' | tail -n 15 | indent
  fail "$TAG is not ready after ${READY_TIMEOUT}s"
fi
banner=$(banner_since "$T0")
grep -E '^ *database ' <<<"$banner" | indent
grep -qE '^ *database +ready$' <<<"$banner" || fail "startup did not report a plain 'database   ready'"
ok "started, nothing applied"
expect "running version" "$NEW_VERSION" "$(runtime_version)"
v=$(live_copy)
check_db "$v" > "$KIT/live.check"
fingerprint "$v" > "$KIT/live.fingerprint"
rm -f "$v"
cmp -s "$KIT/stopped.check" "$KIT/live.check" || { diff "$KIT/stopped.check" "$KIT/live.check" | indent || true; fail "the live report differs from the stopped database's"; }
cmp -s "$KIT/stopped.fingerprint" "$KIT/live.fingerprint" || fail "the live contents differ from the stopped database's"
ok "live database = the stopped one (report and content fingerprint)"
step "owner-only access (through loopback, as Serve forwards)"
access_fitness
step "configuration unchanged"
# Compared, not printed: the Serve status names the tailnet.
serve_now | cmp -s "$KIT/serve-before.txt" - || fail "Serve config changed during the switch (compare tailscale serve status with $KIT/serve-before.txt)"
ok "Serve config identical to before"
unit_state | cmp -s "$KIT/units-before.txt" - || { unit_state | diff "$KIT/units-before.txt" - | indent || true; fail "units, drop-ins or timer changed during the switch"; }
ok "unit files, drop-ins and snapshot timer as before"
expect "failed units" "" "$(failed_units)"
SWITCHED=0

# ---- record
step "record"
n=$(sed -n 's/^migrations *\([0-9]*\) applied, last \(.*\)$/\1/p' <<<"$EXPECT_MIG")
last=$(sed -n 's/^migrations *\([0-9]*\) applied, last \(.*\)$/\2/p' <<<"$EXPECT_MIG")
record=$(printf 'tag=%s\ncommit=%s\nversion=%s\nmigrations=%s\nmigrations_last=%s\ndeployed_at=%s\naction=%s\nprevious_tag=%s\nprevious_commit=%s\nkept=%s\nsnapshot=%s\nsnapshot_sha256=%s\n' \
  "$TAG" "$COMMIT" "$NEW_VERSION" "$n" "$last" "$(utc)" "$MODE" "${DEP_TAG:--}" "$DEP_COMMIT" "$KEPT" "$SNAPSHOT" "$SNAPSHOT_SHA")
as_admin bash -c 'umask 022 && cat > "$1.tmp" && mv -f "$1.tmp" "$1"' _ "$DEPLOYED_FILE" <<<"$record"
LINE="$(utc) $MODE $TAG $COMMIT version=$NEW_VERSION migrations=$n from=${DEP_TAG:-${DEP_COMMIT:0:7}} snapshot=$SNAPSHOT sha256=$SNAPSHOT_SHA result=ok"
as_admin bash -c 'umask 022 && printf "%s\n" "$2" >> "$1"' _ "$RELEASES_LOG" "$LINE"
expect "DEPLOYED" "$COMMIT" "$(kv "$DEPLOYED_FILE" commit)"
indent < "$DEPLOYED_FILE"
printf '\n%s: %s (%s) is live. %d checks passed. Log: %s\n' "$MODE" "$TAG" "${COMMIT:0:7}" "$PASS" "$LOG"
