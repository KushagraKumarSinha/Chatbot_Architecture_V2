import { Redis } from "npm:@upstash/redis";

interface RateLimitOptions {
  windowSizeInSeconds: number;
  maxRequests: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  estimatedCount: number;
  retryAfterSeconds?: number;
  failedOpen?: boolean; // true = Redis/network error, we let it through by default
}

const SLIDING_WINDOW_LUA = `
local currentKey   = KEYS[1]
local previousKey  = KEYS[2]
local maxRequests  = tonumber(ARGV[1])
local windowSize   = tonumber(ARGV[2])
local now          = tonumber(ARGV[3])

local currentWindowStart = now - (now % windowSize)
local elapsedInWindow    = now - currentWindowStart
local overlapPercentage  = 1 - (elapsedInWindow / windowSize)

local previousCount = tonumber(redis.call("GET", previousKey)) or 0
local currentCount  = tonumber(redis.call("GET", currentKey)) or 0

local estimatedCount = (previousCount * overlapPercentage) + currentCount

if estimatedCount >= maxRequests then
  local remaining = math.max(0, maxRequests - math.floor(estimatedCount))
  return {0, remaining, estimatedCount}
end

local newCount = redis.call("INCR", currentKey)
if newCount == 1 then
  redis.call("EXPIRE", currentKey, windowSize * 2)
end

local remaining = math.max(0, maxRequests - math.floor(estimatedCount) - 1)
return {1, remaining, estimatedCount}
`;

export class SlidingWindowRateLimiter {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async rateLimiting(
    identifier: string,
    options: RateLimitOptions,
  ): Promise<RateLimitResult> {
    const { windowSizeInSeconds, maxRequests } = options;
    const now = Math.floor(Date.now() / 1000);

    const currentWindowIndex = Math.floor(now / windowSizeInSeconds);
    const previousWindowIndex = currentWindowIndex - 1;

    const currentKey = `ratelimit:${identifier}:${currentWindowIndex}`;
    const previousKey = `ratelimit:${identifier}:${previousWindowIndex}`;

    try {
      const result = await this.redis.eval(
        SLIDING_WINDOW_LUA,
        [currentKey, previousKey],
        [maxRequests.toString(), windowSizeInSeconds.toString(), now.toString()],
      ) as [number, number, number];

      const [allowedFlag, remaining, estimatedCount] = result;

      return {
        allowed: allowedFlag === 1,
        remaining,
        estimatedCount,
        retryAfterSeconds: allowedFlag === 0 ? windowSizeInSeconds : undefined,
      };
    } catch (err) {
      console.error("Rate limiter error, failing open:", err);
      return {
        allowed: true,
        remaining: maxRequests,
        estimatedCount: 0,
        failedOpen: true,
      };
    }
  }
}

export function getRedisClient(): Redis {
  return new Redis({
    url: Deno.env.get("UPSTASH_REDIS_REST_URL")!,
    token: Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!,
  });
}
