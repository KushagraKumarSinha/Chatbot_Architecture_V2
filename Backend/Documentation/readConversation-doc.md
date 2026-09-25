# `readConversation` Handler

An HTTP handler that lists the authenticated user's conversations, most
recent first, with client-controlled (but bounded) pagination limits,
structured JSON logging, and automatic retries on transient Postgres errors.

---

## How it works

### Step by step

1. **Start timing and establish a request id.** `startTime` captures a
   high-resolution timestamp for measuring total handling duration.
   `requestId` comes from `ctx.requestId` if already set upstream, otherwise
   a fresh UUID is generated, so every log line for the request — including
   across retries — can be correlated.

2. **Authenticate.** If `ctx.userId` is missing, the handler logs a
   `warn`-level `unauthorized` event and returns **401** immediately.

3. **Resolve and validate the page limit.**
   - If the caller didn't supply `payload.limit`, `limit` defaults to
     `DEFAULT_LIMIT` (20).
   - If they did, it's coerced with `Number(...)` and checked: it must be an
     integer and at least `1`. If not, the handler logs `validation_failed`
     (with the invalid value that was received) and returns **400**.
   - A valid limit is then clamped with `Math.min(parsed, MAX_LIMIT)` — so a
     client can ask for a smaller page than the default, but can never ask
     for more than `MAX_LIMIT` (100) rows in one call, regardless of what
     they pass.

4. **Query with retry loop.** The handler attempts up to `MAX_RETRIES` (3)
   times to run a `SELECT` for the user's conversations, most recent first,
   capped at `limit` rows:
   - On success, it logs `conversations_fetched` (with the row count,
     effective limit, which attempt succeeded, and total duration) and
     returns **200** with the list of conversations. Note that an empty
     result set (zero conversations) is still a success — it returns `200`
     with an empty array, not a `404`.
   - If the query throws, the error is checked with `isRetryable()`. If it
     matches one of the known transient Postgres error codes *and* attempts
     remain, the handler logs `retryable_db_error`, waits an exponentially
     increasing jittered delay, and retries. Otherwise it stops.

5. **Exhausted retries / non-retryable error.** If the loop completes without
   returning, the handler logs `read_conversation_failed` (with the last
   error's code, message, and total elapsed time) and returns a generic
   **500**. As with the retry path, no internal error detail is exposed in
   the response body — only in the logs.

### Retry logic in detail

- **Which errors are retried:** `RETRYABLE_CODES` here covers six Postgres
  codes, a broader set than a simple insert-only retry list:
  - `40P01` — deadlock_detected
  - `40001` — serialization_failure
  - `57P01` — admin_shutdown
  - `57P03` — cannot_connect_now
  - `08006` — connection_failure
  - `08003` — connection_does_not_exist

  The last four cover connection-level failures (the DB restarting, shutting
  down, or being briefly unreachable), which makes sense for a read path
  that's expected to be resilient to momentary infrastructure hiccups.
- **Backoff formula:** identical exponential-backoff-with-jitter formula as
  other handlers in this codebase: `2^attempt * 20 * (1 + Math.random())`
  milliseconds (i.e. roughly 20–40ms, then 40–80ms, then 80–160ms).
- **Retry ceiling:** `MAX_RETRIES` (3) total attempts; no sleep/retry after
  the final attempt.

### Structured logging

Same single-line JSON logging convention as other handlers, via the local
`log()` helper. Every entry includes `level`, `event`,
`handler: "readConversation"`, an ISO `timestamp`, and whatever `fields` are
passed in — always including `requestId` and `userId` via `baseFields`, plus
event-specific context (`reason`, `received`, `count`, `limit`, `attempt`,
`delayMs`, `durationMs`, etc.).

---

## Constants

| Name | Value | Purpose |
|---|---|---|
| `MAX_RETRIES` | `3` | Maximum total query attempts before giving up. |
| `DEFAULT_LIMIT` | `20` | Number of conversations returned when the client doesn't specify a `limit`. |
| `MAX_LIMIT` | `100` | Hard ceiling on page size — a client cannot request more than this per call, no matter what they pass. |
| `RETRYABLE_CODES` | `Set` of 6 codes | Postgres error codes considered transient/safe to retry (deadlocks, serialization failures, shutdowns, connection issues). |

---

## Types

### `ConversationRow`

The shape of a conversation row as returned from the database.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Conversation id. |
| `title` | `string` | The conversation's title. |
| `created_at` | `string` | Creation timestamp, as returned by Postgres. |

### `LogLevel`

`"info" \| "warn" \| "error"` — the severity passed to `log()`.

---

## Function reference

### `isRetryable(error: unknown): boolean`

Type-guards a thrown value and checks whether it looks like a Postgres error
object whose `code` is in `RETRYABLE_CODES`. Returns `false` for non-objects,
`null`, or objects without a matching `code`.

### `sleep(ms: number): Promise<void>`

`setTimeout`-based delay used between retry attempts.

### `log(level: LogLevel, event: string, fields?: Record<string, unknown>): void`

Builds and emits a structured JSON log line tagged `handler: "readConversation"`,
routed to `console.log` / `console.warn` / `console.error` based on `level`.

### `readConversation: HandlerFn`

The exported handler. See [How it works](#how-it-works) for full behavior.

**Parameters:**
- `payload` — the request body/query; may optionally contain a `limit`
  field (accepted as a number or a numeric string, since it's coerced with
  `Number(...)`).
- `ctx` — request context; expected to contain `userId` and optionally
  `requestId`.

**Returns:** a `Promise` resolving to `{ status, body }`:

| Status | When | Body |
|---|---|---|
| `200` | Query succeeded (including zero results) | `{ conversations: ConversationRow[] }` |
| `400` | `limit` provided but not a positive integer | `{ error: "'limit' must be a positive integer" }` |
| `401` | No `userId` on the request context | `{ error: "Unauthorized: no user found on request" }` |
| `500` | All retry attempts failed | `{ error: "Failed to fetch conversations" }` |

---

## Usage example

```typescript
const response = await readConversation(
  { limit: 10 },
  { userId: "user_abc123", requestId: "req_xyz" },
);

// response.status === 200
// response.body.conversations === [ { id, title, created_at }, ... up to 10 items ]
```

```typescript
// No limit supplied — falls back to DEFAULT_LIMIT (20)
const response = await readConversation({}, { userId: "user_abc123" });
```

---

## Known limitations

- **No offset/cursor support.** The handler only accepts a `limit` — there's
  no way to page past the first N results (e.g. no `offset` or
  cursor-based `before`/`after`), so a client can only ever get the most
  recent `limit` conversations, never the ones after that.
- **`Number(payload.limit)` accepts more than clients might expect.** Because
  `Number(...)` is used rather than stricter parsing, values like `"20"`
  (numeric strings), `true` (`Number(true) === 1`), or `20.0` all pass the
  integer check. This is a permissive rather than strict validation choice.
- **A non-retryable DB error and an exhausted-retries error look identical to
  the caller** — both return the same generic `500` body, so a client can't
  distinguish "transient issue we gave up on" from "this will never work"
  without access to the logs.
- **The retryable code set is duplicated per-handler** (this handler has a
  broader list than others in the same codebase, e.g. `createConversation`),
  which means updating the "safe to retry" policy requires touching each
  handler file individually rather than one shared source of truth.
