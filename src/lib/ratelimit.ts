import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Lazily created so the module can be imported at build time even when the
// Upstash env vars haven't been set yet (they're only needed at request time).
let _minute: Ratelimit | null = null;
let _day:    Ratelimit | null = null;

function makeRedis(): Redis {
  return new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

/** 10 requests per minute per IP */
export function getRateLimitMinute(): Ratelimit {
  if (!_minute) {
    _minute = new Ratelimit({
      redis:   makeRedis(),
      limiter: Ratelimit.slidingWindow(10, "1 m"),
      prefix:  "rl:analyse:min",
    });
  }
  return _minute;
}

/** 50 requests per day per IP */
export function getRateLimitDay(): Ratelimit {
  if (!_day) {
    _day = new Ratelimit({
      redis:   makeRedis(),
      limiter: Ratelimit.slidingWindow(50, "1 d"),
      prefix:  "rl:analyse:day",
    });
  }
  return _day;
}
