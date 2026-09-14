import { z } from "npm:zod";
import { Registry, RequestBody } from "./types.ts";
import { corsHeaders, getSupabaseClient, jsonResponse, verifyAuth } from "./shared.ts";
import { createConversation } from "./createConversation.ts";
import { readConversation } from "./readConversation.ts";
import { getPastConversations } from "./getPastConversations.ts";
import { chatConversation } from "./chatConversation.ts";
import { deleteConversation } from "./deleteConversation.ts";
import { sql } from "./db.ts";
import { SlidingWindowRateLimiter, getRedisClient } from "./rateLimiter.ts";

const rateLimiter = new SlidingWindowRateLimiter(getRedisClient());

type AlertScope = "ip" | "user";
type LogLevel = "error" | "warn" | "info";

const ALERT_WEBHOOK_URL = Deno.env.get("ALERT_WEBHOOK_URL");
const ALERT_WEBHOOK_TIMEOUT_MS = 3_000;
const ALERT_COOLDOWN_MS = 60_000;

const lastAlertSentAt = new Map<AlertScope, number>();
const suppressedSinceLastAlert = new Map<AlertScope, number>();

function logStructured(level: LogLevel, event: string, context: Record<string, unknown>) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

async function sendAlertWebhook(payload: Record<string, unknown>): Promise<void> {
  if (!ALERT_WEBHOOK_URL) {
    logStructured("warn", "alert_webhook_not_configured", {});
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ALERT_WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      logStructured("error", "alert_webhook_non_ok_response", { status: res.status });
    }
  } catch (err) {
    logStructured("error", "alert_webhook_send_failed", { error: String(err) });
  } finally {
    clearTimeout(timeout);
  }
}

function alertRateLimiterFailedOpen(context: { scope: AlertScope; identifier: string; requestId: string }) {
  const { scope, identifier, requestId } = context;
  const now = Date.now();
  const lastSent = lastAlertSentAt.get(scope) ?? 0;
  const suppressedCount = suppressedSinceLastAlert.get(scope) ?? 0;

  logStructured("error", "rate_limiter_failed_open", {
    scope,
    identifier,
    requestId,
    suppressedSinceLastAlert: suppressedCount,
  });

  if (now - lastSent < ALERT_COOLDOWN_MS) {
    suppressedSinceLastAlert.set(scope, suppressedCount + 1);
    return;
  }

  lastAlertSentAt.set(scope, now);
  suppressedSinceLastAlert.set(scope, 0);

  sendAlertWebhook({
    text: `:rotating_light: Rate limiter failed open (scope: ${scope}, identifier: ${identifier})`,
    scope,
    identifier,
    requestId,
    suppressedSinceLastAlert: suppressedCount,
    timestamp: new Date().toISOString(),
  }).catch(() => {
  });
}

const TRUSTED_PROXY_HOPS = Math.max(1, Number(Deno.env.get("TRUSTED_PROXY_HOPS") ?? "1"));

function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (!forwardedFor) return "unknown";

  const ips = forwardedFor.split(",").map((ip) => ip.trim()).filter(Boolean);
  if (ips.length === 0) return "unknown";

  const trustedIndex = Math.max(0, ips.length - TRUSTED_PROXY_HOPS);
  return ips[trustedIndex] ?? "unknown";
}

function safeLookup<T>(source: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function tooManyRequestsResponse(retryAfterSeconds: number, extra?: Record<string, unknown>): Response {
  const body = JSON.stringify({
    error: "Too many requests",
    retryAfterSeconds,
    ...extra,
  });
  return new Response(body, {
    status: 429,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))),
    },
  });
}

const MethodSchema = z.enum(["CREATE", "READ", "UPDATE", "DELETE"]);

const RequestEnvelopeSchema = z.object({
  method: MethodSchema,
  function_name: z.string().min(1).max(100),
  payload: z.record(z.unknown()).optional().default({}),
});

const payloadSchemas: Record<string, z.ZodTypeAny> = {
  "create-conversation": z.object({
    title: z.string().min(1).max(200),
  }),
  "read-conversation": z.object({}),
  "get-past-conversations": z.object({
    conversation_id: z.string().uuid(),
  }),
  "chat-conversation": z.object({
    conversation_id: z.string().uuid(),
    message: z.string().min(1).max(4000),
  }),
  "delete-conversation": z.object({
    conversation_id: z.string().uuid(),
  }),
};

const registry: Registry = {
  CREATE: { "create-conversation": createConversation },
  READ: {
    "read-conversation": readConversation,
    "get-past-conversations": getPastConversations,
  },
  UPDATE: { "chat-conversation": chatConversation },
  DELETE: { "delete-conversation": deleteConversation },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID();

  try {
    const clientIp = getClientIp(req);
    const ipLimitResult = await rateLimiter.rateLimiting(`ip:${clientIp}`, {
      windowSizeInSeconds: 60,
      maxRequests: 300,
    });

    if (ipLimitResult.failedOpen) {
      alertRateLimiterFailedOpen({ scope: "ip", identifier: clientIp, requestId });
    }

    if (!ipLimitResult.allowed) {
      logStructured("warn", "rate_limit_exceeded", {
        scope: "ip",
        identifier: clientIp,
        requestId,
        retryAfterSeconds: ipLimitResult.retryAfterSeconds,
      });
      return tooManyRequestsResponse(ipLimitResult.retryAfterSeconds);
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body", requestId });
    }

    const envelopeResult = RequestEnvelopeSchema.safeParse(rawBody);
    if (!envelopeResult.success) {
      return jsonResponse(400, {
        error: "Invalid request body",
        details: envelopeResult.error.flatten(),
        requestId,
      });
    }

    const { method, function_name, payload } = envelopeResult.data;
    const { userId } = await verifyAuth(req.headers.get("Authorization"));
    if (!userId) {
      return jsonResponse(401, { error: "Unauthorized: missing or invalid token", requestId });
    }

    const userLimitResult = await rateLimiter.rateLimiting(`user:${userId}`, {
      windowSizeInSeconds: 60,
      maxRequests: 100,
    });

    if (userLimitResult.failedOpen) {
      alertRateLimiterFailedOpen({ scope: "user", identifier: userId, requestId });
    }

    if (!userLimitResult.allowed) {
      logStructured("warn", "rate_limit_exceeded", {
        scope: "user",
        identifier: userId,
        function_name,
        requestId,
        retryAfterSeconds: userLimitResult.retryAfterSeconds,
      });
      return tooManyRequestsResponse(userLimitResult.retryAfterSeconds);
    }

    const methodGroup = registry[method];
    if (!methodGroup) {
      return jsonResponse(400, {
        error: `Unknown method "${method}". Expected one of CREATE, READ, UPDATE, DELETE.`,
        requestId,
      });
    }

    const handler = Object.prototype.hasOwnProperty.call(methodGroup, function_name)
      ? methodGroup[function_name]
      : undefined;
    if (!handler) {
      return jsonResponse(404, {
        error: `No function "${function_name}" registered under method "${method}".`,
        requestId,
      });
    }

    const payloadSchema = safeLookup(payloadSchemas, function_name);
    if (!payloadSchema) {
      return jsonResponse(500, {
        error: `No payload schema defined for "${function_name}".`,
        requestId,
      });
    }

    const payloadResult = payloadSchema.safeParse(payload);
    if (!payloadResult.success) {
      return jsonResponse(400, {
        error: "Invalid payload",
        details: payloadResult.error.flatten(),
        requestId,
      });
    }

    const supabase = getSupabaseClient(req.headers.get("Authorization"));

    const result = await handler(payloadResult.data, { supabase, userId });

    return jsonResponse(result.status, result.body);
  } catch (err) {
    logStructured("error", "router_unhandled_error", { error: String(err), requestId });
    return jsonResponse(500, { error: "Internal server error", requestId });
  }
});
