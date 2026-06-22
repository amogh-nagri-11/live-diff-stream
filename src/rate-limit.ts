import type { NextFunction, Request, Response } from "express";

interface RateLimitOptions {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per client within the window. */
  max: number;
  /** Response message sent on 429. */
  message?: string;
}

/**
 * A small in-memory, per-IP sliding-window rate limiter. Sufficient for a
 * single-process deployment; behind a load balancer or multiple instances each
 * process keeps its own counts, so use a shared store (e.g. Redis) instead.
 *
 * Note: this keys on `req.ip`, which is only trustworthy if Express is told
 * about any upstream proxy via `app.set("trust proxy", ...)`.
 */
export function rateLimit({ windowMs, max, message }: RateLimitOptions) {
  const hits = new Map<string, number[]>();

  // Periodically drop empty/expired buckets so the map can't grow unbounded.
  // `unref` keeps this timer from holding the process open.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const live = times.filter((t) => t > cutoff);
      if (live.length === 0) hits.delete(key);
      else hits.set(key, live);
    }
  }, windowMs);
  sweep.unref?.();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);

    if (recent.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - recent[0])) / 1000);
      res.set("Retry-After", String(retryAfter));
      res
        .status(429)
        .json({ error: message ?? "Too many requests. Please try again later." });
      return;
    }

    recent.push(now);
    hits.set(key, recent);
    next();
  };
}
