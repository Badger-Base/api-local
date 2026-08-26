import type Redis from "ioredis";

const DEFAULT_PREFIX = "pg:query:";
const DEFAULT_TTL = 3600; // 1 hour

export interface CacheOptions {
  /** Redis key namespace. Must end in ':'. */
  prefix?: string;
  /** Expiry in seconds. */
  ttl?: number;
}

export interface QueryCache {
  get<T>(params: Record<string, string>): Promise<T | null>;
  set<T>(params: Record<string, string>, data: T): Promise<void>;
  bustAll(): Promise<void>;
}

/**
 * Redis-backed cache for query-style responses. Keys are built by sorting
 * and joining the request's query params, so identical filter sets (in any
 * param order) hit the same cache entry. All methods fail silently — a
 * Redis outage should degrade to a cache miss, never break the request.
 * The key namespace and expiry are configurable via `options`, defaulting
 * to the `/api/query` cache's `pg:query:` prefix and 1 hour TTL; `bustAll`
 * only clears keys under this instance's own prefix.
 */
export function createCache(redis: Redis, options: CacheOptions = {}): QueryCache {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const ttl = options.ttl ?? DEFAULT_TTL;

  function hashKey(params: Record<string, string>): string {
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return `${prefix}${sorted}`;
  }

  return {
    async get<T>(params: Record<string, string>): Promise<T | null> {
      try {
        const raw = await redis.get(hashKey(params));
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        return null;
      }
    },

    async set<T>(params: Record<string, string>, data: T): Promise<void> {
      try {
        await redis.set(hashKey(params), JSON.stringify(data), "EX", ttl);
      } catch {
        // cache miss is fine
      }
    },

    async bustAll(): Promise<void> {
      try {
        const keys = await redis.keys(`${prefix}*`);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch {
        // best effort
      }
    },
  };
}
