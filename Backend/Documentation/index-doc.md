# `index.ts` — API Router Documentation

## Overview

This file is the **single HTTP entry point** for the API. It is a Deno-based
router that receives all incoming requests, applies cross-cutting concerns
(CORS, rate limiting, authentication, validation, logging/alerting), and
dispatches each request to the appropriate business-logic handler
(`createConversation`, `readConversation`, `getPastConversations`,
`chatConversation`, `deleteConversation`).

The actual business logic lives in those separate handler files — this
component is purely routing, validation, and guardrails.

---

## Request Flow

Every incoming request passes through the following steps, in order. The
first failing check short-circuits the request and returns immediately.

1. **CORS preflight** — `OPTIONS` requests receive an immediate `"ok"`
   response with CORS headers and skip all further processing.
2. **Request ID generated** — a UUID (`requestId`) is created for tracing
   this request through logs.
3. **IP rate limit check** — the client IP is extracted and checked against
   a **300 requests / 60 seconds** limit.
   - If the rate limiter itself failed (e.g. Redis unreachable), it "fails
     open" (allows the request through) and triggers an alert.
   - If the IP is over its limit, the request stops here with **429**.
4. **Body parsing** — the request body is parsed as JSON.
   - Invalid JSON stops here with **400**.
5. **Envelope validation** — the parsed body is validated against
   `RequestEnvelopeSchema` (must contain `method`, `function_name`, and an
   optional `payload`).
   - Failure stops here with **400**.
6. **Authentication** — the `Authorization` header is verified to extract a
   `userId`.
   - Missing or invalid auth stops here with **401**.
7. **User rate limit check** — same mechanism as step 3, but scoped per
   authenticated user at **100 requests / 60 seconds**.
   - Over-limit stops here with **429**.
8. **Method lookup** — `method` (`CREATE` / `READ` / `UPDATE` / `DELETE`) is
   looked up in the `registry`.
   - Unknown method stops here with **400**.
9. **Function lookup** — `function_name` is looked up within that method's
   group of handlers.
   - Unknown function stops here with **404**.
10. **Payload schema lookup** — the matching Zod schema for this
    `function_name` is retrieved from `payloadSchemas`.
    - A missing schema (a configuration bug, not a client error) stops here
      with **500**.
11. **Payload validation** — the request payload is validated against its
    schema.
    - Invalid payload stops here with **400**.
12. **Supabase client created** — a client scoped to the caller's auth
    token is instantiated.
13. **Handler invoked** — the resolved business-logic function is called as
    `handler(validatedPayload, { supabase, userId })`.
14. **Response returned** — whatever `{ status, body }` the handler returns
    is sent back to the client as JSON.
15. **Global error safety net** — any uncaught exception anywhere in steps
    2–14 is caught, logged, and converted into a generic **500** response,
    so internal errors and stack traces never leak to the client.

### Flow diagram

```
Request
  │
  ├─ OPTIONS? ──────────────────────────────► return CORS "ok"
  │
  ▼
Generate requestId
  ▼
IP rate limit check ──── over limit? ───────► 429
  ▼
Parse JSON body ──────── invalid JSON? ─────► 400
  ▼
Validate envelope ────── invalid shape? ────► 400
  ▼
Verify auth (Authorization header) ─ no user? ► 401
  ▼
User rate limit check ── over limit? ───────► 429
  ▼
Look up method in registry ─ unknown? ──────► 400
  ▼
Look up function_name ───── unknown? ───────► 404
  ▼
Look up payload schema ───── missing? ──────► 500
  ▼
Validate payload ────────── invalid? ───────► 400
  ▼
Create Supabase client (scoped to caller)
  ▼
Call handler(payload, { supabase, userId })
  ▼
Return handler's { status, body } as JSON

(any uncaught error at any step) ───────────► 500, logged
```

---

## Function Reference

### `logStructured(level, event, context)`
Emits a single structured JSON log line containing a timestamp, severity
`level` (`"error" | "warn" | "info"`), an `event` name, and arbitrary
`context` fields. Routes to `console.error`, `console.warn`, or
`console.info` depending on `level`.

### `sendAlertWebhook(payload)`
POSTs an alert `payload` to `ALERT_WEBHOOK_URL` (e.g. a Slack incoming
webhook) with a 3-second timeout (`ALERT_WEBHOOK_TIMEOUT_MS`).
- If `ALERT_WEBHOOK_URL` is not configured, logs a warning
  (`alert_webhook_not_configured`) and returns without attempting a
  request — this makes the webhook fully optional.
- If the webhook request fails or times out, logs an error but never
  throws, so alerting failures can't crash the request pipeline.

### `alertRateLimiterFailedOpen({ scope, identifier, requestId })`
Called whenever the rate limiter fails open (i.e. it couldn't reach Redis
and defaulted to allowing the request through). Behavior:
- Always logs an error (`rate_limiter_failed_open`) with the scope
  (`"ip"` or `"user"`), identifier, and how many prior occurrences were
  suppressed since the last alert.
- Sends at most one webhook alert per **60 seconds**
  (`ALERT_COOLDOWN_MS`) per scope, to avoid spamming the alert channel
  during a sustained outage. Occurrences within the cooldown window are
  counted via `suppressedSinceLastAlert` and reported in the next alert
  that does go out.

### `getClientIp(req)`
Extracts the real client IP address from the `x-forwarded-for` header,
accounting for a configurable number of trusted proxy hops
(`TRUSTED_PROXY_HOPS`, default `1`). This prevents a client from spoofing
their IP by injecting fake entries into the header — only the hop at the
trusted position (counting from the end of the list) is used. Returns
`"unknown"` if the header is missing or empty.

### `safeLookup(source, key)`
A prototype-pollution-safe alternative to `source[key]`. Uses
`Object.prototype.hasOwnProperty.call(...)` to ensure the key is an own
property of `source` before returning it, preventing lookups like
`"__proto__"` or `"constructor"` from resolving to unintended values.

### `tooManyRequestsResponse(retryAfterSeconds, extra?)`
Builds and returns a `429 Too Many Requests` HTTP `Response`, including a
`Retry-After` header (rounded up, minimum 1 second) and a JSON body with
an `error` message, `retryAfterSeconds`, and any additional `extra`
fields.

### `Deno.serve(async (req) => { ... })`
The main request handler — implements the full request flow described
above. This is the single entry point for every HTTP request the service
receives.

---

## Key Data Structures

### `MethodSchema`
A Zod enum restricting the `method` field to one of:
`"CREATE" | "READ" | "UPDATE" | "DELETE"`.

### `RequestEnvelopeSchema`
A Zod object schema describing the outer shape every request body must
have:
```ts
{
  method: MethodSchema,
  function_name: string (1–100 chars),
  payload: Record<string, unknown> (optional, defaults to {})
}
```

### `payloadSchemas`
A map from each `function_name` to the Zod schema that validates its
specific expected payload fields:

| `function_name` | Required payload fields |
|---|---|
| `create-conversation` | `title: string (1–200 chars)` |
| `read-conversation` | *(none)* |
| `get-past-conversations` | `conversation_id: string (UUID)` |
| `chat-conversation` | `conversation_id: string (UUID)`, `message: string (1–4000 chars)` |
| `delete-conversation` | `conversation_id: string (UUID)`, `title: string (1–200 chars)` |

### `registry`
A map from `method` → `{ function_name: handlerFunction }`, defining which
business-logic functions are callable under which method:

| Method | Registered functions |
|---|---|
| `CREATE` | `create-conversation` → `createConversation` |
| `READ` | `read-conversation` → `readConversation`, `get-past-conversations` → `getPastConversations` |
| `UPDATE` | `chat-conversation` → `chatConversation` |
| `DELETE` | `delete-conversation` → `deleteConversation` |

---

## Configuration (Environment Variables)

| Variable | Purpose | Required? |
|---|---|---|
| `ALERT_WEBHOOK_URL` | Destination URL (e.g. Slack incoming webhook) for rate-limiter failure alerts. | Optional — if unset, alerts are logged only, no webhook call is made. |
| `TRUSTED_PROXY_HOPS` | Number of trusted proxy hops to account for when parsing `x-forwarded-for`. Defaults to `1`. | Optional |

---

## Guardrails Summary

- **Rate limiting**: two tiers — IP-based (300/60s) and user-based
  (100/60s) — both backed by Redis via `SlidingWindowRateLimiter`. Both
  fail open (allow traffic) if Redis is unreachable, with logging and
  cooldown-throttled alerting so the team is notified without being
  spammed.
- **Validation**: two-stage Zod validation — first the outer request
  envelope, then the per-function payload — ensures malformed requests
  never reach handler code.
- **Authentication**: required before user-level rate limiting or
  dispatch; requests without a valid token never reach any handler.
- **Error handling**: a single top-level `try/catch` around the entire
  request lifecycle ensures no unhandled exception can crash the server
  or leak internal details — every failure path resolves to a
  well-formed JSON response.
