# `deleteConversation` Handler

An HTTP handler that deletes a conversation and all of its messages, after
verifying both that the conversation belongs to the requesting user *and*
that a client-supplied `title` matches the conversation's actual title — a
confirmation step to guard against accidental deletion. Uses the same
`withRetry` helper and structured logging conventions as the other handlers
in this codebase.

---

## How it works

### Step by step

1. **Start timing and establish a request id.** Same pattern as the other
   handlers: `startTime` for duration tracking, `requestId` from
   `ctx.requestId` or a freshly generated UUID.

2. **Authenticate.** Missing `ctx.userId` → logs `unauthorized`, returns
   **401**.

3. **Validate `conversation_id`.** Must be present and a string, otherwise
   logs `validation_failed` (reason `missing_conversation_id`) and returns
   **400**.

4. **Validate `title`.** Must be present, a string, and non-empty after
   `.trim()`, otherwise logs `validation_failed` (reason `missing_title`) and
   returns **400**. Unlike `conversation_id`, there's no separate "too long"
   check here — any non-empty string is accepted at this stage, since its
   only purpose is to be compared against the real title next.

5. **Step 1 — verify ownership and confirm the title.** Looks up the
   conversation the same way as `getPastConversations` (matching both `id`
   and `user_id`), which folds "does this conversation exist" and "does it
   belong to this user" into one indistinguishable-from-outside check:
   - Query failure (after retries) → logs `conversation_lookup_failed`,
     returns **500**.
   - No row found → logs `conversation_not_found`, returns **404**.
   - Row found, but `conversation.title !== title` → logs `title_mismatch`,
     returns **409 Conflict**. This is the confirmation guard: the caller
     must know (and send) the conversation's current exact title to delete
     it, which is a lightweight "type the name to confirm" pattern enforced
     server-side rather than only in a UI.

6. **Step 2 — delete atomically.** Only reached once ownership and title are
   both confirmed. Runs a single database transaction (`sql.begin`) that:
   - Deletes all rows from `messages` for that `conversation_id`.
   - Deletes the row from `conversations` matching both `id` and `user_id`
     (the ownership condition is re-applied here too, not just trusted from
     Step 1).

   Both deletes happen inside one transaction, so the operation is atomic —
   either both succeed or neither is applied, meaning a message table can
   never be left orphaned by a conversation delete that failed partway, or
   vice versa.
   - On success, logs `conversation_deleted` and returns **200** with a
     confirmation message and the deleted `conversation_id`.
   - On failure (after retries), logs `conversation_delete_failed` and
     returns **500**.

### Why retrying the whole transaction is safe

The inline comment in the code calls this out directly: because Postgres
guarantees a failed transaction commits nothing, retrying the *entire*
`sql.begin(...)` block on a transient error (deadlock, serialization
failure, connection drop) is safe in both directions:
- If the original attempt didn't commit, retrying just tries the same delete
  again from scratch.
- If the conversation was already deleted by an earlier retry that actually
  did commit (but the client-visible error made it look like it failed —
  e.g. the connection dropped after commit but before the response), the
  retry's second `DELETE` matches zero rows and is effectively a harmless
  no-op — it doesn't throw, error, or delete anything unexpected.

This is what makes it safe to wrap the *transaction* in `withRetry`, rather
than only wrapping individual statements.

### The `withRetry` helper

Identical implementation to the one described in `getPastConversations`:
takes a zero-argument function and a `fields` object for logging, runs it up
to `MAX_RETRIES` times with exponential-backoff-and-jitter delays between
retryable failures, and re-throws the last error on final failure (leaving
the caller to log a distinctly-named failure event and produce the HTTP
response). Used twice here: once around the ownership lookup, once around
the delete transaction.

### Retry logic in detail

Same six-code `RETRYABLE_CODES` set and same backoff formula
(`2^attempt * 20 * (1 + Math.random())` ms, up to `MAX_RETRIES` = 3
attempts) as `readConversation` and `getPastConversations`.

### Structured logging

Same `log()` convention, tagged `handler: "deleteConversation"`.
Handler-specific event names: `conversation_lookup_failed`,
`conversation_not_found`, `title_mismatch`, `conversation_deleted`,
`conversation_delete_failed` — alongside the shared `unauthorized`,
`validation_failed`, and `retryable_db_error` events.

---

## Constants

| Name | Value | Purpose |
|---|---|---|
| `MAX_RETRIES` | `3` | Maximum attempts per retried operation (lookup and delete transaction, independently). |
| `RETRYABLE_CODES` | `Set` of 6 codes | Postgres error codes treated as transient/safe to retry — same set as `readConversation`/`getPastConversations`. |

Note: this handler has no `limit`-related constants, since it doesn't page
over anything.

---

## Types

### `ConversationRow`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Conversation id. |
| `title` | `string` | The conversation's title, compared against the client-supplied `title` for the confirmation check. |

### `LogLevel`

`"info" \| "warn" \| "error"` — the severity passed to `log()`.

---

## Function reference

### `isRetryable(error: unknown): boolean`

Type-guards a thrown value and checks its `code` against `RETRYABLE_CODES`.
Identical to the other handlers.

### `sleep(ms: number): Promise<void>`

`setTimeout`-based delay used between retries.

### `log(level: LogLevel, event: string, fields?: Record<string, unknown>): void`

Emits a structured JSON log line tagged `handler: "deleteConversation"`.

### `withRetry<T>(fn: () => Promise<T>, fields: Record<string, unknown>): Promise<T>`

Shared retry-with-backoff wrapper (see [Why retrying the whole transaction is
safe](#why-retrying-the-whole-transaction-is-safe) for why it's safe to wrap
an entire transaction with this, not just a single statement).

### `deleteConversation: HandlerFn`

The exported handler. See [How it works](#how-it-works) for full behavior.

**Parameters:**
- `payload` — expected to contain `conversation_id` (string, required) and
  `title` (string, required — must exactly match the conversation's current
  title).
- `ctx` — request context; expected to contain `userId` and optionally
  `requestId`.

**Returns:** a `Promise` resolving to `{ status, body }`:

| Status | When | Body |
|---|---|---|
| `200` | Conversation and its messages deleted | `{ message: "Conversation deleted", conversation_id: string }` |
| `400` | Missing/invalid `conversation_id` or `title` | `{ error: string }` |
| `401` | No `userId` on the request context | `{ error: "Unauthorized: no user found on request" }` |
| `404` | No conversation with that id owned by this user | `{ error: "Conversation not found" }` |
| `409` | Conversation found, but supplied `title` doesn't match | `{ error: "Title does not match this conversation" }` |
| `500` | Lookup or delete transaction failed after retries | `{ error: "Failed to delete conversation" }` |

---

## Usage example

```typescript
const response = await deleteConversation(
  { conversation_id: "conv_123", title: "Planning Q3 roadmap" },
  { userId: "user_abc123", requestId: "req_xyz" },
);

// response.status === 200
// response.body === { message: "Conversation deleted", conversation_id: "conv_123" }
```

```typescript
// Title doesn't match the actual conversation title -> 409, nothing deleted
const response = await deleteConversation(
  { conversation_id: "conv_123", title: "wrong title" },
  { userId: "user_abc123" },
);
```

---

## Known limitations

- **The title-match check is case- and whitespace-sensitive** (aside from a
  single `.trim()` on the client-supplied value — the stored title isn't
  re-trimmed/normalized for comparison). A client that doesn't reproduce the
  title's exact casing will get a `409` even though they clearly identified
  the right conversation.
- **Two separate round trips before the delete** (lookup, then a fresh
  transaction) means there's a small window where the title or ownership
  could theoretically change between the check and the delete; the delete's
  `WHERE id = ... AND user_id = ...` re-check mitigates the ownership half
  of this but not a title change in that window (the delete doesn't
  re-verify title).
- **No soft-delete.** Both `messages` and `conversations` rows are `DELETE`d
  outright inside the transaction — there's no tombstoning or recovery
  window if a deletion turns out to be unwanted.
- **Same generic-500 opacity as the other handlers:** lookup failures and
  delete failures return an identical error body, so a client can't tell
  which step failed without log access.
- **`RETRYABLE_CODES`/`isRetryable`/`withRetry` are duplicated verbatim**
  across this handler and `getPastConversations`, consistent with the
  duplication already noted in the earlier handlers' docs — a good candidate
  to extract into a shared module.
