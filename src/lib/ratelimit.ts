import { Ratelimit, type Duration } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Lazily created so the module can be imported at build time even when the
// Upstash env vars haven't been set yet (they're only needed at request time).
let redis: Redis | null = null;
const limiters = new Map<string, Ratelimit>();

export function isRateLimitConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return redis;
}

/**
 * Returns a sliding-window limiter allowing `max` requests per `window`.
 * Counters are stored under `rl:${name}`. Instances are cached per
 * name + limit, so every caller of the same limiter shares one client.
 */
export function getLimiter(name: string, max: number, window: Duration): Ratelimit {
  const cacheKey = `${name}|${max}|${window}`;
  let limiter = limiters.get(cacheKey);

  if (!limiter) {
    limiter = new Ratelimit({
      redis:   getRedis(),
      limiter: Ratelimit.slidingWindow(max, window),
      prefix:  `rl:${name}`,
    });
    limiters.set(cacheKey, limiter);
  }

  return limiter;
}
