# Sliding Window Rate Limiter

A Redis-backed rate limiter that uses the **sliding window counter** algorithm to
smooth out the burstiness of fixed-window rate limiting, without the cost of
storing a timestamp per request (as a true sliding log would require).

---

## How it works

Instead of tracking every individual request, the limiter divides time into
fixed-size windows (e.g. 60-second buckets) and keeps a single counter per
window. To avoid the "burst at window boundary" problem of naive fixed-window
limiting, it blends the **previous window's count** into the current window's
estimate, weighted by how much of the previous window's duration still
"overlaps" with the current moment.

### Step by step

1. **Bucket the current time.** `now` is divided into windows of
   `windowSizeInSeconds`. The current window index and the previous window
   index are computed, and each is used to build a Redis key:
   `ratelimit:<identifier>:<windowIndex>`.

2. **Compute the overlap weight.** Within the Lua script:
   - `currentWindowStart` = the timestamp where the current window began.
   - `elapsedInWindow` = how many seconds have passed since the window started.
   - `overlapPercentage` = `1 - (elapsedInWindow / windowSize)` — this
     represents how much "weight" the previous window still carries. It's
     `1.0` at the very start of a new window (previous window fully counts)
     and decays linearly to `0.0` by the end of the window (previous window no
     longer matters).

3. **Estimate the request count.** `estimatedCount = previousCount * overlapPercentage + currentCount`.
   This produces a smoothed estimate of "requests in the last `windowSize`
   seconds," rather than "requests since the current window happened to
   start."

4. **Decide allow/deny.**
   - If `estimatedCount >= maxRequests`, the request is **denied**. No counter
     is incremented (the request never happened, as far as Redis is
     concerned).
   - Otherwise, the request is **allowed**, `currentKey` is incremented via
     `INCR`, and — only on the first increment of that key (`newCount == 1`) —
     an `EXPIRE` of `windowSize * 2` is set so the key self-cleans from Redis
     without needing a separate janitor process. The `* 2` gives enough
     buffer for the key to still exist when it's read as the "previous
     window" key in the following window.

5. **Return the result** as a 3-element array: `[allowedFlag, remaining, estimatedCount]`,
   which the TypeScript layer unpacks into a typed `RateLimitResult`.

### Why Lua?

The entire read-estimate-increment sequence runs as a single `EVAL` call, so
it executes atomically on the Redis server. This avoids race conditions that
would occur if the counts were read and incremented as separate round trips
from the application (two concurrent requests could otherwise both read a
count of 9/10 and both be allowed through).

### Fail-open behavior

If the Redis call throws (network error, timeout, Redis outage, etc.), the
limiter does **not** block traffic. It logs the error and returns an
"allowed" result with `failedOpen: true`, so callers can distinguish "allowed
because you're under the limit" from "allowed because we couldn't check the
limit." This is a deliberate availability-over-strictness tradeoff — a rate
limiter outage shouldn't take down the protected service.

---

## Types

### `RateLimitOptions`

| Field | Type | Description |
|---|---|---|
| `windowSizeInSeconds` | `number` | Length of each rate-limit window, in seconds. |
| `maxRequests` | `number` | Maximum number of (estimated) requests allowed per window. |

### `RateLimitResult`

| Field | Type | Description |
|---|---|---|
| `allowed` | `boolean` | Whether the request should be permitted. |
| `remaining` | `number` | Estimated requests remaining in the current window (floored, never negative). |
| `estimatedCount` | `number` | The blended current+previous window estimate used to make the decision. |
| `retryAfterSeconds?` | `number` | Present only when `allowed` is `false`. Currently always set to the full `windowSizeInSeconds` (see [Known limitations](#known-limitations)). |
| `failedOpen?` | `boolean` | `true` if the result was produced by the Redis/network error fallback rather than an actual limit check. |

---

## API Reference

### `SlidingWindowRateLimiter`

A class wrapping an `@upstash/redis` client to provide rate-limit checks.

#### `constructor(redis: Redis)`

Takes an already-configured Upstash `Redis` client instance. The limiter does
not manage the client's lifecycle or credentials — see `getRedisClient()`
below for that.

#### `async rateLimiting(identifier: string, options: RateLimitOptions): Promise<RateLimitResult>`

Checks and records a request against the rate limit for a given identifier
(e.g. a user ID, IP address, or API key).

**Parameters:**
- `identifier` — a unique string identifying the caller being rate-limited.
  Used to namespace the Redis keys, so different identifiers never share a
  counter.
- `options` — the window size and request cap to enforce (see
  `RateLimitOptions` above).

**Behavior:**
- Computes the current and previous window keys for `identifier`.
- Runs `SLIDING_WINDOW_LUA` via `redis.eval`, passing both keys and the
  limit/window/timestamp as arguments.
- Maps the Lua script's `[allowedFlag, remaining, estimatedCount]` response
  into a `RateLimitResult`.
- On any thrown error (e.g. Redis unreachable), catches it, logs it, and
  returns a fail-open `RateLimitResult` with `allowed: true` and
  `failedOpen: true`.

**Returns:** a `Promise` resolving to a `RateLimitResult` describing whether
the request is allowed and the current state of the limit.

---

### `getRedisClient(): Redis`

A small factory function that constructs an Upstash `Redis` client from
environment variables:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Both are read via `Deno.env.get(...)!` — the non-null assertion means this
will throw at call time (not at import time) if either variable is missing,
rather than failing silently with an unauthenticated client.

---

## Usage example

```typescript
const redis = getRedisClient();
const limiter = new SlidingWindowRateLimiter(redis);

const result = await limiter.rateLimiting("user:123", {
  windowSizeInSeconds: 60,
  maxRequests: 100,
});

if (!result.allowed) {
  // reject the request, e.g. return HTTP 429
  console.log(`Rate limited. Retry after ${result.retryAfterSeconds}s`);
} else if (result.failedOpen) {
  // allowed, but only because Redis was unavailable — consider alerting
  console.warn("Rate limiter failed open");
}
```

---

## Known limitations

- **`retryAfterSeconds` is not precise.** It's hardcoded to the full
  `windowSizeInSeconds` rather than the actual time until `estimatedCount`
  drops below `maxRequests`. Callers relying on this value for exact backoff
  timing will over-wait in most cases.
- **The sliding window counter is an approximation**, not an exact count. It
  assumes requests are evenly distributed within the previous window, which
  can under- or over-estimate actual traffic if requests are bursty within a
  single window.
- **Fail-open on error** means that during a Redis outage, rate limiting is
  effectively disabled — this is a deliberate tradeoff (see above) but is
  worth flagging to anyone auditing this for security/abuse-prevention
  guarantees.
- **No jitter/negative protection on `windowSize * 2` TTL**: if a window
  size is very large, keys stay in Redis for a while after they're no longer
  useful; this is a minor memory cost, not a correctness issue.
