#!/usr/bin/env python3
"""LIVE AUDIT WATCHER — tails data/live-audit.jsonl and prints new events
in a human-readable form. Cron watchdog: silent when nothing new.
Cursor (byte offset) persists in data/.audit-cursor.
"""
import json, os, time

ROOT = '/opt/data/iost-terminal'
AUDIT = os.path.join(ROOT, 'data', 'live-audit.jsonl')
CURSOR = os.path.join(ROOT, 'data', '.audit-cursor')

def fmt(e):
    t = time.strftime('%H:%M:%S UTC', time.gmtime(e.get('ts', 0) / 1000))
    ev = e.get('event', '?')
    if ev == 'live.enable':
        return f'● {t} LIVE ENABLED (venue {e.get("venue", "?")}, owner {e.get("owner", "?")})'
    if ev == 'live.disable':
        n = len(e.get('cancelled', []) or [])
        return f'⛔ {t} LIVE DISABLED — kill switch' + (f', cancelled {n} order(s)' if n else '')
    if ev == 'live.order':
        return f'📈 {t} LIVE ORDER {e.get("side", "?").upper()} {e.get("size")} {e.get("symbol", "?")} @ {e.get("entry") or "market"} (venue id {e.get("venueOrderId", "?")})'
    return f'{t} {ev}: {json.dumps({k: v for k, v in e.items() if k not in ("ts", "accountId", "event")})}'

def main():
    if not os.path.exists(AUDIT):
        return  # nothing ever happened — silent
    offset = 0
    if os.path.exists(CURSOR):
        try:
            offset = int(open(CURSOR).read().strip() or 0)
        except ValueError:
            offset = 0
    with open(AUDIT) as f:
        f.seek(offset)
        new = f.read()
        new_offset = f.tell()
    if new_offset > offset:
        with open(CURSOR, 'w') as c:
            c.write(str(new_offset))
    lines = [l for l in new.splitlines() if l.strip()]
    if not lines:
        return
    out = []
    for l in lines:
        try:
            out.append(fmt(json.loads(l)))
        except ValueError:
            out.append(l)
    print('🔴 LIVE TRADING ACTIVITY:')
    print('\n'.join(out))

if __name__ == '__main__':
    main()
