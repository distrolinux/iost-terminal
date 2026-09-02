# Owner Alert Delivery & Escalation Router v1

The Owner Alert Router turns Agent Incident Center transitions and actionable
Safety SLO burn episodes into durable, owner-isolated notifications. It is a
notification service, not a recovery or execution service.

## Safety contract

- The private Owner Control Center inbox is always enabled and records each
  unique alert immediately.
- External delivery is disabled unless the host administrator configures both
  a fixed HTTPS endpoint and a secret file. Neither agents nor browser clients
  can choose a destination.
- Alert payloads omit owner IDs, agent-key IDs, session IDs, wallet/Pact IDs,
  credentials, checkpoints, positions and balances.
- Delivery cannot acknowledge or resolve incidents, release quarantine,
  restart a runtime, modify a mission, change a scope, place a trade, move
  funds, or submit a public-chain action.
- Every channel outcome is appended to a private, hash-chained receipt journal.
  Corrupt or unsupported state fails at service load.
- An exact event replay retains the same CloudEvents `source` + `id` and the
  same `Idempotency-Key`; receivers can safely deduplicate uncertain retries.

## Events and escalation

Incident transitions are deduplicated by incident, status and severity. A new
event is produced for opening, critical escalation, recovery-ready and resolved
states so that recovery cannot be confused with a retry of the original alert.

Safety SLO alerts are emitted only for `budget-at-risk` or `budget-exhausted`.
`not-enrolled`, `warming-up`, `healthy` and an ordinary incident-active state do
not create duplicate SLO notifications. A healthy transition rearms the next
SLO episode. Fast burn or exhausted budget is critical; slower burn is warning.

## Signed webhook protocol

The body is a CloudEvents 1.0 structured JSON event. `source` + `id` is stable
across retries. The request includes a SHA-256 `Content-Digest`, the event ID as
an idempotency key, and an RFC 9421 `Signature-Input`/`Signature` pair using
HMAC-SHA-256. The signature covers method, target URI, content digest, content
type and alert ID, with a five-minute creation/expiry window.

The sender resolves the configured hostname itself, rejects private, loopback,
link-local, multicast and IP-literal destinations, connects to the checked
public address with the original hostname as TLS SNI, and does not follow
redirects. Timeout is five seconds.

Host configuration is optional:

```text
IOST_OWNER_ALERT_WEBHOOK_URL=https://alerts.example.com/iost
IOST_OWNER_ALERT_WEBHOOK_SECRET_FILE=/run/secrets/iost-owner-alert-webhook
```

The secret file must contain 32–4096 bytes and deny group/other access. The
status API reports only whether the channel is enabled; it never returns the
URL, file path or secret.

## Retry and dead-letter policy

HTTP 2xx is delivered. HTTP 408, 425, 429 and 5xx, timeouts and network errors
use bounded exponential backoff with deterministic 20% jitter. A numeric
`Retry-After` is honored up to 15 minutes. Other 4xx responses fail immediately.
After six attempts the alert enters the private dead-letter state for owner
review. Retries never create a second logical event.

## Interfaces

- `GET /api/agent-alerts` — private, `no-store`, owner- or agent-key-bound status.
- `agent_owner_alert_status` — private read-only MCP view of alerts, channels,
  retry state and receipt-chain verification.
- Agent Control Center — owner inbox, delivery health and recent alert cards.

## Protocol alignment

- CloudEvents 1.0.2 core specification:
  <https://github.com/cloudevents/spec/blob/ce@v1.0.2/cloudevents/spec.md>
- HTTP Message Signatures, RFC 9421:
  <https://www.rfc-editor.org/rfc/rfc9421.html>
- Content-Digest fields, RFC 9530:
  <https://www.rfc-editor.org/rfc/rfc9530.html>
- AWS Builders' Library, timeouts, retries and backoff with jitter:
  <https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/>

## Acceptance requirements

1. Exact incident observations create one alert; a recovery transition creates
   a distinct event.
2. Warming-up does not page the owner and one actionable SLO episode emits once.
3. Owner and agent-key isolation holds in REST, MCP and Control Center output.
4. Signed payloads contain stable replay identity and no private identity data.
5. Retriable outcomes back off; permanent failures and exhausted retries enter
   dead letter; success records delivery.
6. The private state file is mode 0600 and the receipt chain verifies.
7. No test creates a reservation, trade, live action or public-chain action.
