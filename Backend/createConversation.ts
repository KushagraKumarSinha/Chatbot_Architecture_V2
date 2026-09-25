import { HandlerFn } from "./types.ts";
import { sql } from "./db.ts";

const MAX_TITLE_LENGTH = 200;
const MAX_RETRIES = 3;

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
}

const RETRYABLE_CODES = new Set(["40P01", "40001"]);

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

// --- Structured logging helper ---
// Emits single-line JSON so log aggregators can parse/filter/query on fields.
type LogLevel = "info" | "warn" | "error";

function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
) {
  const entry = {
    level,
    event,
    handler: "createConversation",
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const createConversation: HandlerFn = async (payload, ctx) => {
  const startTime = performance.now();
  // Prefer a request id supplied by upstream (e.g. from ctx or headers);
  // fall back to generating one so every log line is correlatable.
  const requestId = ctx.requestId ?? crypto.randomUUID();

  const baseFields = { requestId, userId: ctx.userId };

  if (!ctx.userId) {
    log("warn", "unauthorized", baseFields);
    return { status: 401, body: { error: "Unauthorized: no user found on request" } };
  }

  const rawTitle = payload?.title;

  if (typeof rawTitle !== "string") {
    log("warn", "validation_failed", { ...baseFields, reason: "title_not_string" });
    return { status: 400, body: { error: "A non-empty 'title' string is required" } };
  }

  const title = rawTitle.trim();

  if (!title) {
    log("warn", "validation_failed", { ...baseFields, reason: "title_empty" });
    return { status: 400, body: { error: "A non-empty 'title' string is required" } };
  }

  if (title.length > MAX_TITLE_LENGTH) {
    log("warn", "validation_failed", {
      ...baseFields,
      reason: "title_too_long",
      titleLength: title.length,
    });
    return {
      status: 400,
      body: { error: `'title' must be ${MAX_TITLE_LENGTH} characters or fewer` },
    };
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const [data] = await sql<ConversationRow[]>`
        INSERT INTO conversations (user_id, title)
        VALUES (${ctx.userId}, ${title})
        RETURNING id::text, title, created_at
      `;

      if (!data) {
        log("error", "insert_no_row_returned", { ...baseFields, attempt });
        return { status: 500, body: { error: "Failed to create conversation" } };
      }

      log("info", "conversation_created", {
        ...baseFields,
        conversationId: data.id,
        attempt,
        durationMs: Math.round(performance.now() - startTime),
      });

      return { status: 201, body: { conversation: data } };
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

  log("error", "create_conversation_failed", {
    ...baseFields,
    attempts: MAX_RETRIES,
    code: (lastError as { code?: string })?.code,
    message: lastError instanceof Error ? lastError.message : String(lastError),
    durationMs: Math.round(performance.now() - startTime),
  });

  return { status: 500, body: { error: "Failed to create conversation" } };
};
