# `createConversation` Handler

An HTTP handler that creates a new conversation row for the authenticated
user, with input validation, structured JSON logging, and automatic retries
on transient Postgres errors.

---

## How it works

### Step by step

1. **Start timing and establish a request id.** `startTime` captures a
   high-resolution timestamp so total handling duration can be logged later.
   `requestId` is taken from `ctx.requestId` if the caller/framework already
   set one (e.g. from an upstream header), otherwise a fresh UUID is
   generated — this guarantees every log line for this request can be
   correlated, even across retries.

2. **Authenticate.** If `ctx.userId` is missing, the handler immediately logs
   a `warn`-level `unauthorized` event and returns **401**. No further
   processing happens.

3. **Validate the title.** The `title` field from `payload` is checked in
   three stages, each with its own logged reason and a **400** response:
   - Not a string → `title_not_string`.
   - Empty after `.trim()` (including strings that are only whitespace) →
     `title_empty`.
   - Longer than `MAX_TITLE_LENGTH` (200 characters) → `title_too_long`
     (with the offending length logged for debugging).

4. **Insert with retry loop.** The handler attempts up to `MAX_RETRIES` (3)
   times to `INSERT` the conversation and get its row back via `RETURNING`:
   - On success, it logs `conversation_created` (including the new
     conversation id, which attempt succeeded, and total duration) and
     returns **201** with the created conversation.
   - If the insert returns no row at all (unexpected, since `INSERT ...
     RETURNING` should always return the inserted row), it logs
     `insert_no_row_returned` as an `error` and returns **500** immediately,
     without retrying — this isn't treated as a transient condition.
   - If the query throws, the error is checked with `isRetryable()`. If it's
     one of the known transient Postgres error codes *and* attempts remain,
     the handler logs `retryable_db_error`, waits an exponentially increasing
     delay with jitter, and tries again. Otherwise it stops retrying.

5. **Exhausted retries / non-retryable error.** If the loop ends without
   returning (all retries used, or a non-retryable error was thrown), the
   handler logs `create_conversation_failed` — including the last error's
   code and message and the total elapsed time — and returns a generic
   **500** to the caller. The underlying error details are never leaked into
   the HTTP response body, only into the logs.

### Retry logic in detail

- **Which errors are retried:** only Postgres error codes `40P01`
  (deadlock detected) and `40001` (serialization failure) — both are
  transient concurrency errors that are safe and often correct to retry,
  as opposed to e.g. a constraint violation, which retrying would never fix.
- **Backoff formula:** `2^attempt * 20 * (1 + Math.random())` milliseconds.
  This is exponential backoff (20ms, 40ms, 80ms, ...) with up to 2x random
  jitter added, which spreads out retries from multiple concurrent requests
  so they don't all retry in lockstep and re-collide.
- **Retry ceiling:** the loop runs at most `MAX_RETRIES` (3) times total
  (i.e. the initial attempt plus up to 2 retries), and does not sleep/retry
  after the final attempt — it just falls through to the failure path.

### Structured logging

The internal `log()` helper emits a single-line JSON object per call so that
log aggregators (Datadog, CloudWatch Insights, etc.) can parse and query on
fields rather than grepping free-text messages. Every entry includes:

- `level` — `"info"`, `"warn"`, or `"error"` (also determines whether it's
  written via `console.log`, `console.warn`, or `console.error`).
- `event` — a short machine-readable event name (e.g. `validation_failed`,
  `conversation_created`).
- `handler` — hardcoded to `"createConversation"`, useful when logs from many
  handlers are aggregated together.
- `timestamp` — ISO 8601 timestamp.
- Any additional `fields` passed in, which always include `requestId` and
  `userId` via `baseFields`, plus event-specific context (e.g. `attempt`,
  `reason`, `durationMs`).

---

## Constants

| Name | Value | Purpose |
|---|---|---|
| `MAX_TITLE_LENGTH` | `200` | Maximum allowed length (in characters) for a conversation title. |
| `MAX_RETRIES` | `3` | Maximum total insert attempts before giving up. |
| `RETRYABLE_CODES` | `Set(["40P01", "40001"])` | Postgres error codes considered safe to retry (deadlock, serialization failure). |

---

## Types

### `ConversationRow`

The shape of a conversation row as returned from the database.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Conversation id, cast to text in the query (`id::text`). |
| `title` | `string` | The conversation's title. |
| `created_at` | `string` | Creation timestamp, as returned by Postgres. |

### `LogLevel`

`"info" \| "warn" \| "error"` — the severity passed to `log()`.

---

## Function reference

### `isRetryable(error: unknown): boolean`

Type-guards and checks whether a thrown value looks like a Postgres error
object with a `code` property matching one of `RETRYABLE_CODES`. Returns
`false` for anything that isn't an object, is `null`, or lacks a matching
`code`.

### `sleep(ms: number): Promise<void>`

A minimal `setTimeout`-based delay helper used to pause between retry
attempts.

### `log(level: LogLevel, event: string, fields?: Record<string, unknown>): void`

Builds and writes a structured JSON log line (see [Structured
logging](#structured-logging) above). Routes to `console.log`,
`console.warn`, or `console.error` based on `level`.

### `createConversation: HandlerFn`

The exported handler itself. See [How it works](#how-it-works) for its full
behavior.

**Parameters:**
- `payload` — the request body; expected to (optionally) contain a `title`
  field.
- `ctx` — request context, expected to contain `userId` (set by upstream
  auth middleware) and optionally `requestId`.

**Returns:** a `Promise` resolving to `{ status, body }`:

| Status | When | Body |
|---|---|---|
| `201` | Conversation created successfully | `{ conversation: ConversationRow }` |
| `400` | `title` missing, not a string, empty, or too long | `{ error: string }` describing the specific validation failure |
| `401` | No `userId` on the request context | `{ error: "Unauthorized: no user found on request" }` |
| `500` | Insert returned no row, or all retry attempts failed | `{ error: "Failed to create conversation" }` |

---

## Usage example

```typescript
const response = await createConversation(
  { title: "  Planning Q3 roadmap  " },
  { userId: "user_abc123", requestId: "req_xyz" },
);

// response.status === 201
// response.body.conversation === { id: "...", title: "Planning Q3 roadmap", created_at: "..." }
```

---

## Known limitations

- **Non-retryable errors surface no detail to the caller.** Any DB error
  outside the two retryable codes goes straight to the generic 500 path —
  which is safe, but means callers can't distinguish e.g. a bad connection
  string from a genuine outage without reading logs.
- **No cap on total wall-clock retry time.** With jitter, three attempts
  could add up to roughly 20–160ms of extra latency in the worst case before
  failing — small, but worth knowing under tight timeout budgets.
- **`isRetryable` trusts the shape of `error.code` without validating it's a
  string** beyond the `as` cast; a thrown object with a non-string `code`
  that happens to loosely match would not match `.has()` (which requires
  exact string equality), so this is a low-risk but untyped assumption.
- **Title trimming happens after the "is it a string" check but before the
  "is it empty" check**, which is intentional (e.g. `"   "` is rejected as
  empty) but worth noting since the error message doesn't distinguish
  "empty" from "whitespace-only" for the caller.
