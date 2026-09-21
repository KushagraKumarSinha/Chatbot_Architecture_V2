import { HandlerFn } from "./types.ts";
import { sql } from "./db.ts";

const MAX_RETRIES = 3;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100; // hard ceiling so a client can't request an unbounded page

interface ConversationRow {
  id: string;
  title: string;
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
    handler: "readConversation",
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const readConversation: HandlerFn = async (payload, ctx) => {
  const startTime = performance.now();
  const requestId = ctx.requestId ?? crypto.randomUUID();
  const baseFields = { requestId, userId: ctx.userId };

  if (!ctx.userId) {
    log("warn", "unauthorized", baseFields);
    return { status: 401, body: { error: "Unauthorized: no user found on request" } };
  }

  // Optional client-supplied limit, clamped to a safe range.
  let limit = DEFAULT_LIMIT;
  if (payload?.limit !== undefined) {
    const parsed = Number(payload.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      log("warn", "validation_failed", {
        ...baseFields,
        reason: "invalid_limit",
        received: payload.limit,
      });
      return { status: 400, body: { error: "'limit' must be a positive integer" } };
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const data = await sql<ConversationRow[]>`
        SELECT id, title, created_at
        FROM conversations
        WHERE user_id = ${ctx.userId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;

      log("info", "conversations_fetched", {
        ...baseFields,
        count: data.length,
        limit,
        attempt,
        durationMs: Math.round(performance.now() - startTime),
      });

      return { status: 200, body: { conversations: data } };
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string })?.code;

      if (isRetryable(error) && attempt < MAX_RETRIES - 1) {
        const delay = 2 ** attempt * 20 * (1 + Math.random());
        log("warn", "retryable_db_error", {
          ...baseFields,
          attempt,
          code,
          delayMs: Math.round(delay),
        });
        await sleep(delay);
        continue;
      }

      break;
    }
  }

  log("error", "read_conversation_failed", {
    ...baseFields,
    attempts: MAX_RETRIES,
    code: (lastError as { code?: string })?.code,
    message: lastError instanceof Error ? lastError.message : String(lastError),
    durationMs: Math.round(performance.now() - startTime),
  });

  return { status: 500, body: { error: "Failed to fetch conversations" } };
};
