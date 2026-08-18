import type Redis from "ioredis";

const CACHE_PREFIX = "pg:query:";
const CACHE_TTL = 3600; // 1 hour

export interface QueryCache {
  get<T>(params: Record<string, string>): Promise<T | null>;
  set<T>(params: Record<string, string>, data: T): Promise<void>;
  bustAll(): Promise<void>;
}

/**
 * Redis-backed cache for `/api/query` responses. Keys are built by sorting
 * and joining the request's query params, so identical filter sets (in any
 * param order) hit the same cache entry. All methods fail silently — a
 * Redis outage should degrade to a cache miss, never break the request.
 */
export function createCache(redis: Redis): QueryCache {
  function hashKey(params: Record<string, string>): string {
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return `${CACHE_PREFIX}${sorted}`;
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
        await redis.set(hashKey(params), JSON.stringify(data), "EX", CACHE_TTL);
      } catch {
        // cache miss is fine
      }
    },

    async bustAll(): Promise<void> {
      try {
        const keys = await redis.keys(`${CACHE_PREFIX}*`);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch {
        // best effort
      }
    },
  };
}
