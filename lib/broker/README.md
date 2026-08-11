# Broker Interface Contract (v1)

The execution-venue boundary for IOST Terminal. Every venue (paper today;
kraken/ibkr in v2) implements this contract so the trading engine never
touches venue specifics.

## Shape

```js
{
  name: 'paper' | 'kraken' | 'ibkr',
  getAccount(accountId)      -> { ok, account }         // cash, equity, positions, journal
  getQuotes(symbols[])       -> { ok, quotes }          // { SYM: { last, ts } }
  getPositions(accountId)    -> { ok, positions }
  getOrders(accountId)       -> { ok, orders }          // resting orders (paper: none)
  placeOrder(order)          -> { ok, position }        // market/limit execution
  cancelOrder(orderId, accountId) -> { ok, error? }     // cancel a resting order
}
```

## Rules

- **All methods are async** and return plain objects.
- **Business errors are returned, not thrown:** `{ ok: false, error: '<msg>' }`.
  Throwing is reserved for programmer errors / venue outages (callers wrap in try/catch).
- **Execution only.** Settlement (cash, journal, P&L) is the engine's job
  (`lib/paper.js`), not the broker's. Closes go through engine settlement,
  which may place an opposite-side order on a live venue.
- **Quotes are always fresh** — never return a cached price as `last` without a `ts`.
- **Validated at the boundary.** Route handlers validate user input; brokers
  validate their own params before touching the venue.
- **Never leak secrets.** Brokers read venue keys from env at construction
  time; nothing key-shaped ever appears in return values.

## Venue notes

- **paper** — instant fills at market price; no resting orders; `cancelOrder`
  returns `{ ok: false, error: 'No resting orders in paper mode' }`.
- **kraken (v2)** — REST client; `placeOrder` returns venue order id; key
  permissions Query+Trade, IP-locked, withdraw disabled.

## Registry

`lib/broker/index.js`:

```js
import { getBroker } from './index.js';
const broker = getBroker('paper');   // default; throws on unknown venue
```

## Adding a venue (v2)

1. Implement the six methods in `lib/broker/<venue>.js`.
2. Register it in `lib/broker/index.js`.
3. Route execution through the registry — the engine never imports a venue
   module directly.
