# `getPastConversations` Handler

An HTTP handler that fetches the most recent messages in a specific
conversation, after verifying that conversation belongs to the requesting
user. Shares a common retry-with-backoff helper across its two database
calls, and uses the same structured JSON logging pattern as the other
handlers in this codebase.

---

## How it works

### Step by step

1. **Start timing and establish a request id.** `startTime` captures a
   high-resolution timestamp for measuring total handling duration.
   `requestId` comes from `ctx.requestId` if already set, otherwise a fresh
   UUID is generated, so every log line for the request can be correlated.

2. **Authenticate.** If `ctx.userId` is missing, the handler logs `warn`
   `unauthorized` and returns **401** immediately.

3. **Validate `conversation_id`.** `payload.conversation_id` must be present
   and a string. If not, the handler logs `validation_failed` (reason
   `missing_conversation_id`) and returns **400**.

4. **Resolve and validate the message limit.** Same pattern as
   `readConversation`: if `payload.limit` is omitted, it defaults to
   `DEFAULT_LIMIT` (20); if supplied, it must be a positive integer
   (`400` + `invalid_limit` otherwise) and is clamped to `MAX_LIMIT` (100).

5. **Step 1 — verify conversation ownership.** The handler queries
   `conversations` for a row matching *both* the given `id` **and**
   `user_id = ctx.userId`. This single condition does double duty: it's how
   the handler confirms the conversation exists *and* enforces that a user
   can't read another user's conversation by guessing/passing their
   `conversation_id` — a not-found row and a not-owned row are
   indistinguishable to the caller, which is the correct behavior for
   avoiding leaking the existence of other users' data.
   - If the query throws (after retries are exhausted), it logs
     `conversation_lookup_failed` and returns **500**.
   - If no row is returned, it logs `conversation_not_found` and returns
     **404**.

6. **Step 2 — fetch messages.** Only reached if the conversation lookup
   succeeded. Queries `messages` for the given `conversation_id`, ordered
   `created_at DESC LIMIT limit` — i.e. it fetches the **most recent**
   `limit` messages first — then calls `.reverse()` on the result before
   returning it. This means the final `orderedMessages` array is in
   **chronological (oldest-first) order**, but only within the fetched page:
   it's "the last `limit` messages, presented oldest-to-newest," not "the
   first `limit` messages of the conversation."
   - On success, logs `messages_fetched` (count, duration) and returns
     **200** with both the conversation summary (`id`, `title`) and the
     ordered messages.
   - On failure (after retries), logs `messages_fetch_failed` and returns
     **500**.

### The `withRetry` helper

Rather than duplicating the retry `for` loop for each of the two queries (as
seen in `createConversation` and `readConversation`), this handler factors
retry logic into a shared generic helper:

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  fields: Record<string, unknown>
): Promise<T>
```

- Takes a zero-argument function `fn` that performs the actual query, and a
  `fields` object merged into any log lines it emits.
- Internally runs the same exponential-backoff-with-jitter loop as the other
  handlers (`2^attempt * 20 * (1 + Math.random())` ms delay, up to
  `MAX_RETRIES` attempts), retrying only when `isRetryable(error)` is true
  and attempts remain.
- Unlike the other handlers, **`withRetry` does not itself produce the final
  error log or HTTP response** — on final failure it just `throw`s the last
  error back to the caller. Each call site (`Step 1` and `Step 2` above) is
  responsible for catching that and logging its own distinctly-named failure
  event (`conversation_lookup_failed` vs. `messages_fetch_failed`) and
  returning the appropriate response. This is what lets both steps report
  failures under different event names while sharing one retry
  implementation.

### Retry logic in detail

- **Which errors are retried:** the same six-code set used by
  `readConversation` — deadlocks, serialization failures, admin shutdown,
  "cannot connect now," and two connection-failure codes. Same rationale:
  both handlers are read paths that can tolerate transient infra hiccups.
- **Backoff formula & ceiling:** identical to the other handlers — up to
  `MAX_RETRIES` (3) attempts, exponential delay with jitter between them.

### Structured logging

Uses the same `log()` convention as the other handlers, tagged
`handler: "getPastConversations"`. Notable event names specific to this
handler: `conversation_lookup_failed`, `conversation_not_found`,
`messages_fetched`, `messages_fetch_failed` — in addition to the common
`unauthorized`, `validation_failed`, and `retryable_db_error` events shared
with the rest of the codebase.

---

## Constants

| Name | Value | Purpose |
|---|---|---|
| `MAX_RETRIES` | `3` | Maximum attempts per query (applied independently to each of the two queries via `withRetry`). |
| `DEFAULT_LIMIT` | `20` | Number of messages returned when the client doesn't specify a `limit`. |
| `MAX_LIMIT` | `100` | Hard ceiling on how many messages can be requested per call. |
| `RETRYABLE_CODES` | `Set` of 6 codes | Postgres error codes treated as transient/safe to retry. |

---

## Types

### `ConversationRow`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Conversation id. |
| `title` | `string` | The conversation's title. |

Note: this is a narrower shape than the `ConversationRow` used in
`createConversation`/`readConversation` (no `created_at`) — it's a
locally-scoped type matching exactly what this handler's `SELECT` asks for.

### `MessageRow`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Message id. |
| `messages` | `string` | The message content/body. *(Field is literally named `messages`, singular content — see [Known limitations](#known-limitations).)* |
| `by` | `string` | Who sent the message (e.g. a role or user identifier). |
| `created_at` | `string` | Timestamp the message was created. |

### `LogLevel`

`"info" \| "warn" \| "error"` — the severity passed to `log()`.

---

## Function reference

### `isRetryable(error: unknown): boolean`

Type-guards a thrown value and checks whether its `code` is in
`RETRYABLE_CODES`. Identical implementation to the other handlers.

### `sleep(ms: number): Promise<void>`

`setTimeout`-based delay used between retries.

### `log(level: LogLevel, event: string, fields?: Record<string, unknown>): void`

Emits a structured JSON log line tagged `handler: "getPastConversations"`.

### `withRetry<T>(fn: () => Promise<T>, fields: Record<string, unknown>): Promise<T>`

Shared retry-with-backoff wrapper described above. Re-throws the last error
if all attempts fail; does not log a terminal failure event itself (callers
do that).

### `getPastConversations: HandlerFn`

The exported handler. See [How it works](#how-it-works) for full behavior.

**Parameters:**
- `payload` — expected to contain `conversation_id` (string, required) and
  optionally `limit` (positive integer, coerced via `Number(...)`).
- `ctx` — request context; expected to contain `userId` and optionally
  `requestId`.

**Returns:** a `Promise` resolving to `{ status, body }`:

| Status | When | Body |
|---|---|---|
| `200` | Conversation found and messages fetched | `{ conversation: { id, title }, messages: MessageRow[] }` (chronological order) |
| `400` | Missing/invalid `conversation_id`, or invalid `limit` | `{ error: string }` |
| `401` | No `userId` on the request context | `{ error: "Unauthorized: no user found on request" }` |
| `404` | No conversation with that id owned by this user | `{ error: "Conversation not found" }` |
| `500` | Conversation lookup or message fetch failed after retries | `{ error: "Failed to fetch messages" }` |

---

## Usage example

```typescript
const response = await getPastConversations(
  { conversation_id: "conv_123", limit: 50 },
  { userId: "user_abc123", requestId: "req_xyz" },
);

// response.status === 200
// response.body.conversation === { id: "conv_123", title: "..." }
// response.body.messages === [ oldest ... newest ]  (up to 50 messages)
```

---

## Known limitations

- **Only the most recent page of a conversation is reachable.** As with
  `readConversation`, there's no offset/cursor, so if a conversation has more
  than `limit` messages, everything before the most recent `limit` is
  unreachable through this handler.
- **Two round trips are not wrapped in a single transaction.** The ownership
  check and the message fetch are separate queries; in the (unlikely) window
  between them, the conversation could theoretically be deleted or
  reassigned. This is a minor risk for a read-only endpoint but worth noting
  if stronger consistency is ever needed.
- **`MessageRow.messages` is a potentially confusing field name** — it holds
  a single message's content (singular), while the field name is plural,
  which invites confusion with the outer `messages: MessageRow[]` array in
  the response body.
- **Same generic-500 opacity as other handlers:** both `conversation_lookup_failed`
  and `messages_fetch_failed` return the identical `{ error: "Failed to
  fetch messages" }` body, so a client can't distinguish which step failed
  without server-side log access.
- **`RETRYABLE_CODES` and `isRetryable` are duplicated verbatim** from
  `readConversation` rather than imported from a shared module, consistent
  with the duplication noted in that handler's docs.
