import { HandlerFn } from "./types.ts";
import { sql } from "./db.ts";

const MAX_RETRIES = 3;

interface ConversationRow {
  id: string;
  title: string;
}

const RETRYABLE_CODES = new Set([
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "08006", // connection_failure
  "08003", // connection_does_not_exist
]);

function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    RETRYABLE_CODES.has((error as { code: string }).code)
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LogLevel = "info" | "warn" | "error";

function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
) {
  const entry = {
    level,
    event,
    handler: "deleteConversation",
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  fields: Record<string, unknown>
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string })?.code;

      if (isRetryable(error) && attempt < MAX_RETRIES - 1) {
        const delay = 2 ** attempt * 20 * (1 + Math.random());
        log("warn", "retryable_db_error", { ...fields, attempt, code, delayMs: Math.round(delay) });
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  throw lastError;
}

export const deleteConversation: HandlerFn = async (payload, ctx) => {
  const startTime = performance.now();
  const requestId = ctx.requestId ?? crypto.randomUUID();
  const baseFields = { requestId, userId: ctx.userId };

  if (!ctx.userId) {
    log("warn", "unauthorized", baseFields);
    return { status: 401, body: { error: "Unauthorized: no user found on request" } };
  }

  const conversationId = payload?.conversation_id;
  const rawTitle = payload?.title;

  if (!conversationId || typeof conversationId !== "string") {
    log("warn", "validation_failed", { ...baseFields, reason: "missing_conversation_id" });
    return { status: 400, body: { error: "A valid 'conversation_id' is required" } };
  }

  if (!rawTitle || typeof rawTitle !== "string" || !rawTitle.trim()) {
    log("warn", "validation_failed", { ...baseFields, reason: "missing_title" });
    return { status: 400, body: { error: "A non-empty 'title' string is required" } };
  }

  const title = rawTitle.trim();
  const fields = { ...baseFields, conversationId };

  // --- Step 1: verify the conversation belongs to this user, and title matches ---
  let conversation: ConversationRow | undefined;
  try {
    [conversation] = await withRetry<ConversationRow[]>(
      () => sql`
        SELECT id, title
        FROM conversations
        WHERE id = ${conversationId} AND user_id = ${ctx.userId}
      `,
      fields
    );
  } catch (error) {
    log("error", "conversation_lookup_failed", {
      ...fields,
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string })?.code,
      durationMs: Math.round(performance.now() - startTime),
    });
    return { status: 500, body: { error: "Failed to delete conversation" } };
  }

  if (!conversation) {
    log("warn", "conversation_not_found", fields);
    return { status: 404, body: { error: "Conversation not found" } };
  }

  if (conversation.title !== title) {
    log("warn", "title_mismatch", fields);
    return { status: 409, body: { error: "Title does not match this conversation" } };
  }

  // --- Step 2: delete messages + conversation atomically ---
  // Safe to retry the whole transaction on deadlock/serialization failure:
  // Postgres guarantees a failed transaction commits nothing, so a retry
  // either succeeds cleanly or (if the conversation is already gone) is a no-op.
  try {
    await withRetry(
      () =>
        sql.begin(async (tx) => {
          await tx`DELETE FROM messages WHERE conversation_id = ${conversationId}`;
          await tx`DELETE FROM conversations WHERE id = ${conversationId} AND user_id = ${ctx.userId}`;
        }),
      fields
    );

    log("info", "conversation_deleted", {
      ...fields,
      durationMs: Math.round(performance.now() - startTime),
    });

    return { status: 200, body: { message: "Conversation deleted", conversation_id: conversationId } };
  } catch (error) {
    log("error", "conversation_delete_failed", {
      ...fields,
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string })?.code,
      durationMs: Math.round(performance.now() - startTime),
    });
    return { status: 500, body: { error: "Failed to delete conversation" } };
  }
};
