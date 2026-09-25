import { HandlerFn } from "./types.ts";
import { sql } from "./db.ts";

const MAX_RETRIES = 3;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface ConversationRow {
  id: string;
  title: string;
}

interface MessageRow {
  id: string;
  messages: string;
  by: string;
  created_at: string;
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
    handler: "getPastConversations",
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Generic retry wrapper so both queries below share the same backoff logic
// instead of duplicating the for-loop twice.
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

export const getPastConversations: HandlerFn = async (payload, ctx) => {
  const startTime = performance.now();
  const requestId = ctx.requestId ?? crypto.randomUUID();
  const baseFields = { requestId, userId: ctx.userId };

  if (!ctx.userId) {
    log("warn", "unauthorized", baseFields);
    return { status: 401, body: { error: "Unauthorized: no user found on request" } };
  }

  const conversationId = payload?.conversation_id;

  if (!conversationId || typeof conversationId !== "string") {
    log("warn", "validation_failed", { ...baseFields, reason: "missing_conversation_id" });
    return { status: 400, body: { error: "A valid 'conversation_id' is required" } };
  }

  let limit = DEFAULT_LIMIT;
  if (payload?.limit !== undefined) {
    const parsed = Number(payload.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      log("warn", "validation_failed", { ...baseFields, reason: "invalid_limit", received: payload.limit });
      return { status: 400, body: { error: "'limit' must be a positive integer" } };
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const fields = { ...baseFields, conversationId, limit };

  // --- Step 1: verify the conversation belongs to this user ---
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
    return { status: 500, body: { error: "Failed to fetch messages" } };
  }

  if (!conversation) {
    log("warn", "conversation_not_found", fields);
    return { status: 404, body: { error: "Conversation not found" } };
  }

  // --- Step 2: fetch messages for that conversation ---
  try {
    const messages = await withRetry<MessageRow[]>(
    () => sql`
      SELECT id, messages, by, created_at
      FROM messages
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `,
    fields
  );

  const orderedMessages = messages.reverse();

    log("info", "messages_fetched", {
      ...fields,
      count: orderedMessages.length,
      durationMs: Math.round(performance.now() - startTime),
    });

    return {
      status: 200,
      body: {
        conversation: { id: conversation.id, title: conversation.title },
        messages: orderedMessages,
      },
    };
  } catch (error) {
    log("error", "messages_fetch_failed", {
      ...fields,
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string })?.code,
      durationMs: Math.round(performance.now() - startTime),
    });
    return { status: 500, body: { error: "Failed to fetch messages" } };
  }
};
