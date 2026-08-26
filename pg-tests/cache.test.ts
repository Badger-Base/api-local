import { describe, it, expect } from "bun:test";
import { createCache } from "../pg/cache.ts";

/** Minimal in-memory stand-in for the ioredis surface createCache uses. */
function fakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, _ex: string, seconds: number) {
      store.set(key, value);
      ttls.set(key, seconds);
      return "OK";
    },
    async keys(pattern: string) {
      const prefix = pattern.replace(/\*$/, "");
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async del(...keys: string[]) {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
  };
}

describe("createCache", () => {
  it("defaults to the pg:query: prefix and a 1 hour TTL", async () => {
    const redis = fakeRedis();
    const cache = createCache(redis as any);
    await cache.set({ a: "1" }, { ok: true });

    const key = [...redis.store.keys()][0];
    expect(key).toBe("pg:query:a=1");
    expect(redis.ttls.get(key)).toBe(3600);
  });

  it("honors a custom prefix and TTL", async () => {
    const redis = fakeRedis();
    const cache = createCache(redis as any, { prefix: "pg:suggest:", ttl: 300 });
    await cache.set({ q: "comp" }, { suggestions: [] });

    const key = [...redis.store.keys()][0];
    expect(key).toBe("pg:suggest:q=comp");
    expect(redis.ttls.get(key)).toBe(300);
  });

  it("bustAll only clears its own prefix", async () => {
    const redis = fakeRedis();
    const queryCache = createCache(redis as any);
    const suggestCache = createCache(redis as any, { prefix: "pg:suggest:", ttl: 300 });

    await queryCache.set({ a: "1" }, { ok: true });
    await suggestCache.set({ q: "comp" }, { suggestions: [] });

    await queryCache.bustAll();

    expect(redis.store.has("pg:query:a=1")).toBe(false);
    expect(redis.store.has("pg:suggest:q=comp")).toBe(true);
  });

  it("builds identical keys regardless of param order", async () => {
    const redis = fakeRedis();
    const cache = createCache(redis as any);
    await cache.set({ b: "2", a: "1" }, { ok: true });
    const hit = await cache.get({ a: "1", b: "2" });
    expect(hit).toEqual({ ok: true });
  });
});
