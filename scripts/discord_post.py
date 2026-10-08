#!/usr/bin/env python3
"""Post the latest daily close to a Discord channel through a webhook.

Runs from GitHub Actions after the price data changes. Needs the
DISCORD_WEBHOOK_URL secret; without it, it does nothing.
"""
import json
import os
import statistics
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "snapshots.json"


def main():
    hook = os.environ.get("DISCORD_WEBHOOK_URL")
    if not hook:
        print("DISCORD_WEBHOOK_URL not set; skipping")
        return
    snaps = json.loads(DATA.read_text())["snapshots"]
    closes = [s for s in snaps if s.get("kind") == "close" and s.get("console")]
    if not closes:
        print("no daily close yet; skipping")
        return
    last = closes[-1]
    if os.environ.get("ONLY_NEW_CLOSE") and closes[-1]["t"] < (datetime.now(timezone.utc) - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%MZ"):
        print("latest close is old; skipping")
        return
    prev = closes[-2] if len(closes) > 1 else None
    t_last = datetime.strptime(last["t"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    lines = []
    for r in range(81, 92):
        v = last["console"].get(str(r))
        if not v:
            continue
        window = [s["console"][str(r)][0] for s in snaps
                  if s.get("console") and s["console"].get(str(r))
                  and t_last - timedelta(days=7) < datetime.strptime(s["t"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc) <= t_last]
        fair = statistics.median(window) if len(window) >= 6 else None
        chg = ""
        if prev and prev["console"].get(str(r)):
            c = v[0] / prev["console"][str(r)][0] - 1
            chg = f"{c:+.0%} vs yesterday"
        flag = ""
        if fair and v[0] <= fair * 0.9:
            flag = " · **cheap**"
        elif fair and v[0] >= fair * 1.15:
            flag = " · **expensive**"
        lines.append(f"`{r}`  {v[0]:,}  {chg}{flag}")
    site = os.environ.get("SITE_URL", "")
    body = {
        "username": "Fodder Tracker",
        "embeds": [{
            "title": "Console fodder, 5pm close",
            "url": site or None,
            "description": "\n".join(lines),
            "footer": {"text": "Cheapest listing per rating, from FUTBIN"},
            "timestamp": t_last.isoformat(),
        }],
    }
    req = urllib.request.Request(hook, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json", "User-Agent": "fc27-fodder-tracker"})
    with urllib.request.urlopen(req) as resp:
        print("posted", resp.status)


if __name__ == "__main__":
    main()
