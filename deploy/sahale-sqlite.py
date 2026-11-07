#!/usr/bin/env python3
"""
Consistent copies and checks of Sahale's SQLite database. Python 3 standard library only,
so it runs on the laptop and the server without installing anything.

  sahale-sqlite.py snapshot SRC DEST   online backup of SRC into DEST, verified, atomically replaced
  sahale-sqlite.py check DB            integrity, foreign keys, migrations, row counts, recent sessions

The source is opened read-only and copied with SQLite's online backup API (the same
mechanism as `npm run db -- backup`), so it is safe while Sahale is running. The copy is
switched out of WAL mode so it is one self-contained file, checked with
`PRAGMA integrity_check` and `foreign_key_check`, and only then renamed over DEST.

`check` prints a stable report: run it on the source and on the copy and diff the two.
Exit status is non-zero if anything fails.
"""
import os
import sqlite3
import sys
from pathlib import Path


def connect_ro(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise SystemExit(f"no database at {path}")
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)


def verify(db: sqlite3.Connection) -> None:
    integrity = [r[0] for r in db.execute("PRAGMA integrity_check")]
    if integrity != ["ok"]:
        raise SystemExit(f"integrity_check failed: {integrity[:5]}")
    broken = db.execute("PRAGMA foreign_key_check").fetchall()
    if broken:
        raise SystemExit(f"foreign_key_check found {len(broken)} broken references")


def fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def snapshot(src: Path, dest: Path) -> None:
    tmp = dest.with_name(f".{dest.name}.tmp-{os.getpid()}")
    old_umask = os.umask(0o077)
    try:
        source = connect_ro(src)
        target = sqlite3.connect(tmp)
        try:
            source.backup(target)
            target.execute("PRAGMA journal_mode = DELETE")
            verify(target)
        finally:
            target.close()
            source.close()
        with open(tmp, "rb") as f:
            os.fsync(f.fileno())
        os.replace(tmp, dest)
        fsync_dir(dest.parent)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    finally:
        os.umask(old_umask)
    print(f"snapshot {dest}  ({dest.stat().st_size} bytes, integrity ok)")


def check(path: Path) -> None:
    db = connect_ro(path)
    try:
        db.execute("BEGIN")  # one read transaction: every number comes from the same moment
        verify(db)
        print("integrity        ok")
        print("foreign keys     ok")
        has_migrations = db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").fetchone()
        applied = db.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at").fetchall() if has_migrations else []
        print(f"migrations       {len(applied)} applied, last {applied[-1][0] if applied else '-'}")
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for t in tables:
            n = db.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0]
            print(f"rows  {t:<32} {n}")
        if "fitness_sessions" in tables:
            active = db.execute("SELECT count(*) FROM fitness_sessions WHERE status = 'active'").fetchone()[0]
            print(f"active workouts  {active}")
            recent = db.execute(
                """
                SELECT s.started_at, s.status, s.name, count(DISTINCT e.id), count(ss.id), coalesce(sum(ss.done), 0)
                FROM fitness_sessions s
                LEFT JOIN fitness_session_entries e ON e.session_id = s.id
                LEFT JOIN fitness_session_sets ss ON ss.entry_id = e.id
                WHERE s.origin = 'owner'
                GROUP BY s.id ORDER BY s.started_at DESC LIMIT 5
                """
            ).fetchall()
            for started, status, name, entries, sets, done in recent:
                print(f"session  {started}  {status:<9} {name}  ({entries} exercises, {sets} sets, {done} done)")
        db.execute("ROLLBACK")
    finally:
        db.close()


def main(argv: list[str]) -> None:
    if len(argv) == 3 and argv[0] == "snapshot":
        snapshot(Path(argv[1]), Path(argv[2]))
    elif len(argv) == 2 and argv[0] == "check":
        check(Path(argv[1]))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
