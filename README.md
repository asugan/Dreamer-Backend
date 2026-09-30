# Dreamer Backend

Express 5 + TypeScript + SQLite backend for Dream Thread. No email/password flow.
Calls your existing CLIProxyAPI server's OpenAI-compatible `/v1/chat/completions` endpoint;
there is no direct OpenAI SDK or provider integration.

## Setup

Node.js **22.19+** required (`node:sqlite` is experimental on Node 22).

```sh
npm ci
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Put the generated value in DATA_KEY and fill the other required settings.
npm run dev
```

| Setting | Value |
| --- | --- |
| `DATA_KEY` | Stable 32-byte hex encryption/HMAC key; back it up securely |
| `CLIPROXY_BASE_URL` | URL including `/v1`, e.g. `http://127.0.0.1:8317/v1` |
| `CLIPROXY_API_KEY` | Proxy client API key, **not** its management key |
| `CLIPROXY_MODEL` | Exact model configured on the proxy |
| `REVENUECAT_SECRET_KEY` | Server-only RevenueCat API key |
| `REVENUECAT_MONTHLY_PRODUCT_ID` | Exact monthly App Store product attached to `premium` |

Startup fails with missing configuration. There is no payment/auth bypass.
`ALLOW_SANDBOX=true` is only for a separate development/TestFlight environment.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

Tests run a local Express HTTP server and SQLite, mocking upstream HTTP responses.
They do not contact paid services. The sibling mobile app is not modified/connected yet.

## Client flow and API

1. `POST /v1/sessions` with `{}` returns `{userId, token, expiresAt, consentVersion}`.
   Persist the token in secure device storage; it is a password. The user ID is not a credential.
2. Configure/log in to RevenueCat using that **server-issued userId** before purchase/restore.
3. Explain proxy/upstream AI transfer and temporary response retention; obtain explicit consent.
   `PUT /v1/consent` with `{granted: true, version: "2026-10-01"}` records it.
4. All remaining endpoints require `Authorization: Bearer <token>`. Persist each request UUID
   and its exact body locally before sending; retries use the same ID/body.
5. Save successful results in the device journal; handle `safety: support` as help-seeking guidance.
   Convert nullable `connectionId` to the mobile model's optional field if necessary.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Public process/SQLite liveness, not upstream readiness |
| POST | `/v1/sessions` | Public anonymous session creation |
| POST | `/v1/session/renew` | New 90-day token; old token overlaps for at most five minutes |
| DELETE | `/v1/session` | Revoke all tokens/consent and erase temporary content caches |
| PUT | `/v1/consent` | Grant/withdraw consent; withdrawal purges temporary content |
| GET | `/v1/membership` | Live verified entitlement, expiry and quota usage |
| POST | `/v1/interpretations` | Structured reflection or cached replay |
| POST | `/v1/weekly` | Summary from 3–20 interpreted entries within seven days |

Interpretation request:

```json
{
  "requestId": "3956a338-4e2e-4a1a-a26a-56de61c51a6a",
  "dream": {
    "id": "local-dream-1",
    "date": "2026-10-01",
    "text": "I walked beside a quiet lake.",
    "mood": "Peaceful",
    "context": ""
  },
  "history": [{
    "id": "local-dream-0", "date": "2026-09-29",
    "summary": "A quiet garden.", "themes": ["Calm"]
  }]
}
```

History is optional and capped at 20 entries, three theme labels per entry. Text limit is
8,000 characters, context 1,000, history summaries 800. Unknown fields/duplicate IDs are rejected.
Success is `{requestId, cached, result}`. Interpretation result includes `title`, `summary`,
`themes`, `meaning`, `question`, `connectionId`, `safety`, and server-added `sourceText`.
References must match supplied history IDs; local record contents cannot be independently
verified without storing the journal.

Weekly request is `{requestId, entries: [...]}`, using the history-entry shape above.
Result includes `title`, `summary`, `question`, `sourceIds`. The mobile client must persist
weekly summaries against record IDs **and versions**, invalidate on editing/deletion and reuse
them rather than issue a new request on every visit.

## Payments, quotas and retries

Every new generation verifies the authenticated identity's RevenueCat `premium` entitlement
and the configured monthly product. Only purchased App Store subscriptions are supported.
Expired, refunded, family-shared, promotional and (by default) sandbox access is rejected.
Cancellation keeps access until paid expiry; verified billing grace is allowed. Outages fail closed.

Limits: **30 interpretations / four weekly summaries per verified purchase period**.
Usage is keyed by verified store transaction and purchase date, not installation/user ID.
Restoring/transferring the same purchase period cannot reset its usage. Missing transaction
evidence fails closed. Annual plans need a separate quota policy.

SQLite atomically reserves usage before network I/O. One pending generation per subscription,
ten globally. `DAILY_GENERATION_LIMIT` defaults to 200 UTC-day reservations, including failures.
This is an attempt budget, not measured dollars. Model/input/output token usage is stored when
returned by the proxy; actual money costs depend on your upstream arrangement.

Completed retries return the encrypted cached result for 24 hours without another AI call/charge.
Content cleanup runs every ten minutes and at startup. ID/fingerprint/status/quota tombstones
remain, so an expired or failed ID never generates again.

CLIProxyAPI is not assumed to guarantee exactly-once processing. A timeout, upstream 5xx or
process crash may occur **after generation**: these requests become `uncertain`, stay charged,
and never auto-regenerate. Reconciliation requires checking proxy records. Explicit rejections
and invalid outputs release user quota, but still consume the global daily attempt budget.

Errors are `{error: "machine_code"}`. Translate them to friendly UI messages; keep the draft.

| HTTP | Codes | Action |
| --- | --- | --- |
| 400 / 413 | `invalid_request`, `invalid_json`, `request_too_large` | Correct input |
| 401 | `invalid_session` | Use valid stored token, otherwise new identity + restore |
| 402 | `subscription_required` | Purchase/restore |
| 403 | `consent_required` | Explain and request permission |
| 409 | `request_pending`, `generation_in_progress`, `request_exists` | Wait; retry same ID/body |
| 409 | `request_id_conflict` | Don't reuse an ID for different content |
| 409 / 502 | `request_uncertain`, `generation_uncertain` | No automatic new-ID retry |
| 409 / 502 | `request_failed`, `generation_failed` | Quota released; explicit new attempt needs new ID |
| 410 | `result_expired` | Use locally saved result |
| 429 | `rate_limited`, `quota_exceeded` | Stop automatic retries |
| 503 | `subscription_service_unavailable`, `service_busy`, `daily_budget_reached` | Retry later |

## Deployment and privacy

- **One process/instance with persistent local disk**. No cluster mode, ephemeral serverless disk,
  or shared network SQLite file. Startup marks leftover pending requests uncertain.
- Default bind is loopback. Use an HTTPS reverse proxy. `TRUST_PROXY` must be the actual proxy
  IP/CIDR allowlist, never blindly trusted forwarded headers. Add ingress abuse limits.
- Durable rate limits: 120 requests/minute/IP, 60/minute/user, 10 registrations/hour/IP,
  1,000 registrations/day globally, 10 generation attempts/hour/user. Anonymous auth alone
  doesn't prove a genuine device; CAPTCHA/App Attest isn't included.
- Keep `.env`, data directory, key and backups private. Server applies a restrictive umask.
  Use SQLite backup tooling / `VACUUM INTO` or stop the service for backups; copying only the
  database during WAL writes is unsafe.
- No permanent journal copy. Temporary results (including source text) are AES-256-GCM encrypted;
  request fingerprints and rate-limit IP identifiers use HMAC. Raw bodies, tokens, replies and
  exception messages are not logged.
- Consent withdrawal erases caches and blocks new generation; an already-dispatched request
  cannot be unsent. Session deletion retains minimal accounting/tombstones, doesn't cancel
  App Store purchases and doesn't delete device-local dreams.
- The proxy/upstream may keep its own logs/content. Verify retention before privacy claims.
  Safety prompting is implemented; a 30-case model quality/safety evaluation and live
  purchase/restore tests remain release requirements.
- Losing/expiring the token loses this backend identity. Restore can recover purchases via a
  new ID, not the local journal. A user ID alone never recovers authentication.
- No CORS middleware: the intended client is the native mobile app.

References: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI),
[RevenueCat customer API](https://www.revenuecat.com/docs/api-v1/customers),
[Express error handling](https://expressjs.com/en/guide/error-handling/),
[Node SQLite](https://nodejs.org/api/sqlite.html).
