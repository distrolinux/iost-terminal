#!/usr/bin/env python3
"""LIVE RECONCILIATION — diff Kraken venue state vs local audit trail.
Runs every 5 min as a cron watchdog: prints ONLY when something is off
(untracked orders/positions, or placed orders missing from the venue),
so a healthy run stays silent. Read-only: never places/cancels anything.

Exit 0 always (connectivity failures are printed, not fatal).
"""
import json, time, hmac, hashlib, base64, urllib.request, urllib.parse, os

ROOT = '/opt/data/iost-terminal'
ENV = os.path.join(ROOT, '.env')
AUDIT = os.path.join(ROOT, 'data', 'live-audit.jsonl')

def load_env(path):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return env

def private_call(env, method, params=None):
    key, secret = env.get('KRAKEN_API_KEY', ''), env.get('KRAKEN_API_SECRET', '')
    if not key or not secret:
        raise RuntimeError('Kraken keys missing from .env')
    params = params or {}
    nonce = str(int(time.time() * 1_000_000))  # µs — must stay strictly increasing per key
    postdata = urllib.parse.urlencode({'nonce': nonce, **params})
    path = f'/0/private/{method}'
    msg = path.encode() + hashlib.sha256((nonce + postdata).encode()).digest()
    sig = base64.b64encode(hmac.new(base64.b64decode(secret), msg, hashlib.sha512).digest()).decode()
    req = urllib.request.Request('https://api.kraken.com' + path, data=postdata.encode(),
                                 headers={'API-Key': key, 'API-Sign': sig})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = json.loads(r.read())
    if body.get('error'):
        raise RuntimeError('; '.join(body['error']))
    return body.get('result', {})

def known_txids():
    """All venueOrderIds we ever logged (live.order events) — local truth."""
    ids = set()
    try:
        with open(AUDIT) as f:
            for line in f:
                try:
                    e = json.loads(line)
                    if e.get('event') == 'live.order' and e.get('venueOrderId'):
                        ids.add(e['venueOrderId'])
                except ValueError:
                    continue
    except FileNotFoundError:
        pass
    return ids

def main():
    env = load_env(ENV)
    if not env.get('KRAKEN_API_KEY'):
        print('⚠️ LIVE RECON: no Kraken keys configured — skipping')
        return
    try:
        orders = private_call(env, 'OpenOrders').get('open', {})
        positions = private_call(env, 'OpenPositions')
    except Exception as e:
        print(f'⚠️ LIVE RECON: cannot reach Kraken — {e}')
        return

    known = known_txids()
    venue_ids = set(orders) | set(positions)
    untracked = venue_ids - known
    issues = []

    if untracked:
        for tid in sorted(untracked):
            o = orders.get(tid) or {}
            issues.append(f'  UNTRACKED {tid} {o.get("descr", {}).get("pair", "?")} {o.get("descr", {}).get("type", "?")} vol={o.get("vol", "?")}')

    # orders we placed but no longer visible on the venue (filled/cancelled) — info only
    placed = known - venue_ids
    if placed:
        issues.append(f'  RESOLVED (filled/cancelled): {len(placed)} order(s) no longer open on venue')

    if issues:
        print(f'⚠️ LIVE RECON ({time.strftime("%H:%M")} UTC):')
        print('\n'.join(issues))
        print(f'  venue open orders: {len(orders)} · open positions: {len(positions)}')

if __name__ == '__main__':
    main()
