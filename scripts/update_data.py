#!/usr/bin/env python3
"""Maintain data/snapshots.json, the price history the website reads.

Two inputs feed it:
  --csv FILE        the 3-hourly fodder log (timestamp_utc,rating,cheapest_player,
                    price_pc,price_ps,source). Rows already present are skipped.
  --snapshot FILE   one fresh reading as JSON:
                    {"t": "2026-10-08T21:00Z", "kind": "close",
                     "console": {"81": [650, "Name"], ...},
                     "pc":      {"81": [650, "Name"], ...}}

Every reading passes the same checks before it is kept, so a bad page load
(FUTBIN once served last year's game) never reaches the charts.
"""
import argparse
import csv
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path

RATINGS = [str(r) for r in range(81, 92)]
DATA = Path(__file__).resolve().parent.parent / "data" / "snapshots.json"
# PlayStation prices in the 3-hourly log were stale before this point.
CONSOLE_TRUSTED_FROM = "2026-10-08T00:00Z"
OUTLIER_RATIO = 2.5


def load():
    if DATA.exists():
        return json.loads(DATA.read_text())
    return {"source": "futbin.com/stc/cheapest", "console_trusted_from": CONSOLE_TRUSTED_FROM,
            "snapshots": []}


def plausible(platform_prices):
    """Reject a whole platform reading that does not look like FC27 fodder."""
    p = {r: v[0] for r, v in platform_prices.items() if v and v[0]}
    if len(p) < 8:
        return False
    # 91s cost several times more than 90s in FC27; FC25 pages showed them close together.
    if "91" in p and "90" in p and p["91"] < 1.8 * p["90"]:
        return False
    # Prices should broadly climb with rating.
    if "85" in p and "88" in p and p["88"] <= p["85"]:
        return False
    return True


def drop_outliers(snaps):
    """Blank single values that jump far from their recent median (bad parses)."""
    for platform in ("console", "pc"):
        for r in RATINGS:
            held = [s for s in snaps if s.get(platform, {}).get(r)]
            values = [s[platform][r][0] for s in held]
            bad = []
            for i, v in enumerate(values):
                # Compare with up to four neighbours on each side, so the first reading is checked too.
                around = values[max(0, i - 4):i] + values[i + 1:i + 5]
                if not around:
                    continue
                med = statistics.median(around)
                if v > med * OUTLIER_RATIO or v < med / OUTLIER_RATIO:
                    bad.append(i)
            for i in bad:
                held[i][platform][r] = None


def add(db, snap):
    times = {s["t"] for s in db["snapshots"]}
    if snap["t"] in times:
        # A daily close replaces an intraday reading at the same minute.
        if snap.get("kind") == "close":
            db["snapshots"] = [s for s in db["snapshots"] if s["t"] != snap["t"]]
        else:
            return False
    for platform in ("console", "pc"):
        if platform in snap and not plausible(snap[platform]):
            print(f"rejected {platform} reading at {snap['t']}: failed sanity checks")
            snap.pop(platform)
    if "console" not in snap and "pc" not in snap:
        return False
    db["snapshots"].append(snap)
    return True


def from_csv(path):
    rows = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            t = row["timestamp_utc"].strip()
            s = rows.setdefault(t, {"t": t, "kind": "intraday", "console": {}, "pc": {}})
            name = row["cheapest_player"].strip()
            if row["price_pc"]:
                s["pc"][row["rating"]] = [int(float(row["price_pc"])), name]
            if row["price_ps"] and t >= CONSOLE_TRUSTED_FROM:
                s["console"][row["rating"]] = [int(float(row["price_ps"])), name]
    for s in rows.values():
        if not s["console"]:
            s.pop("console")
    return list(rows.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv")
    ap.add_argument("--snapshot")
    args = ap.parse_args()

    db = load()
    added = 0
    if args.csv:
        for s in from_csv(args.csv):
            added += add(db, s)
    if args.snapshot:
        added += add(db, json.loads(Path(args.snapshot).read_text()))

    db["snapshots"].sort(key=lambda s: s["t"])
    drop_outliers(db["snapshots"])
    db["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(db, ensure_ascii=False, separators=(",", ":")))
    print(f"added {added} readings; {len(db['snapshots'])} total")


if __name__ == "__main__":
    main()
