/**
 * `fetchClientMetadataResource` for `cimd()` (Client ID Metadata Documents,
 * RFC-in-progress) — the network boundary better-auth's OAuth provider uses
 * to fetch a dynamically-registering MCP client's metadata document during
 * an authorization request.
 *
 * ## Why this file exists instead of using `@better-auth/cimd/node` directly
 *
 * `@better-auth/cimd@1.7.2` ships a Node implementation of this exact
 * contract at `@better-auth/cimd/node` (`fetchClientMetadataResource`) that
 * is DNS-rebinding-safe: it resolves the hostname once, validates every
 * answer against RFC 6890 special-use ranges, and pins the *same* validated
 * address for the connection via a custom `https.request({ lookup })`.
 *
 * That implementation was tried first here and does not run under Bun.
 * Reproduced directly (independent of this package — a minimal
 * `node:https.request(url, { lookup: (h, o, cb) => cb(null, ip, family) })`
 * against `https://example.com` fails identically):
 *
 *   TypeError: results.sort is not a function
 *     at node:_http_client:269   (Bun's Node-compat HTTP client)
 *     at lookup (.../@better-auth/cimd/dist/node.mjs:50)
 *
 * Root cause: Node's `https.request` only invokes a custom `lookup` callback
 * with the multi-address `{ all: true }` shape when Happy-Eyeballs
 * (`autoSelectFamily`) is active for that request, and respects
 * `net.setDefaultAutoSelectFamily(false)` / a per-request
 * `autoSelectFamily: false` option to fall back to the classic single-address
 * `(err, address, family)` callback shape that `@better-auth/cimd`'s `lookup`
 * always calls back with. Bun's `node:https` compat shim always calls
 * `lookup` with `{ all: true }` and ignores both the global and per-request
 * `autoSelectFamily: false` overrides (verified directly against Bun
 * 1.3.14 — see task-7-report.md for the isolated repro). The package's
 * `lookup` never branches on `options.all`, so under Bun it always hands
 * back the old two-argument shape into code that now expects an array,
 * and Bun's compat layer throws before a connection is ever attempted.
 *
 * This is a genuine incompatibility between the pinned `@better-auth/cimd`
 * version and Bun's Node-compat `https` client, not something fixable from
 * a wrapper around the exported function — the crash happens inside the
 * package's own `dist/node.mjs`, before it returns control to us.
 *
 * ## What this fallback provides, and — importantly — what it does NOT
 *
 * This performs one `dns.lookup` and rejects the whole request if *any*
 * returned address is not public-routable (RFC 6890), using the same
 * classifier (`isPublicRoutableHost`) the packaged CIMD transport itself
 * uses. That rules out the common cases: `localhost`, RFC 1918 ranges,
 * link-local (including cloud instance-metadata IPs), loopback, etc.
 *
 * It does **not** meet the full contract `@better-auth/cimd`'s own type
 * declares ("the transport MUST resolve the hostname exactly once ... and
 * pin the approved address for the connection"). Concretely, unmet:
 *
 * 1. **Not resolve-once / not pinned.** The address-validation lookup here
 *    and the DNS lookup Bun's `fetch()` performs internally for the actual
 *    connection are two separate resolutions. A DNS-rebinding attacker who
 *    controls the metadata host's authoritative resolver can return a
 *    public address for the first lookup (passing this check) and a
 *    private/loopback address for the second (the one `fetch()` actually
 *    connects to), landing the request on an internal host anyway. This is
 *    the exact TOCTOU gap `@better-auth/cimd`'s doc comment calls out as
 *    unfixable "by wrapping the standard Fetch API after DNS resolution."
 *
 *    What keeps that gap survivable rather than critical: this transport is
 *    HTTPS-only and Bun's `fetch` verifies certificates by default, so a
 *    rebound connection only completes if the internal host it lands on
 *    serves a certificate valid for the *attacker's* hostname — which no
 *    internal service does. Rebinding therefore degrades from an SSRF read
 *    primitive to a blind connect-and-fail probe: the attacker learns
 *    timing, not content. The residual risk is a coarse internal port-scan
 *    timing oracle. That is the basis on which this fallback was accepted;
 *    it is not a claim that the gap is closed.
 * 2. **No connection-level pinning.** There is no way to force Bun's global
 *    `fetch()` to connect to one specific resolved address while still
 *    presenting the original hostname as the TLS SNI/Host — that requires a
 *    custom `lookup` at the socket layer, which is exactly the code path
 *    that crashes under Bun (see above).
 *
 * What IS enforced: HTTPS-only, no automatic redirect following
 * (`redirect: "manual"` — a 3xx is returned to the caller unfollowed,
 * matching "refuse redirects"), a capped response body read before anything
 * attempts to parse it as JSON, and a single 5s deadline spanning DNS
 * resolution, connection and body read together. The deadline covers the
 * lookup deliberately: `dns.lookup` has no timeout of its own, so a
 * hostname whose authoritative resolver simply stalls would otherwise hold
 * the authorization request open with no bound at all.
 *
 * If `@better-auth/cimd` ships a Bun-compatible (or runtime-agnostic) build
 * in a later version, switch back to its packaged `fetchClientMetadataResource`
 * and delete this file.
 */
import { isPublicRoutableHost } from "@better-auth/core/utils/host";
import { lookup } from "node:dns/promises";
import type { Awaitable } from "@better-auth/core";

/** Refuse to buffer a client metadata document larger than this. */
const MAX_BODY_BYTES = 1_000_000;

/** The transport MUST NOT hang the authorization request it runs inside. */
const FETCH_TIMEOUT_MS = 5000;

type ClientMetadataResourceFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Awaitable<Response>;

/**
 * Applies one shared deadline to a step that has no `AbortSignal` of its own
 * (`dns.lookup`, the capped body read). The wrapped promise is left to settle
 * on its own; `Promise.race` has already attached handlers to it, so a late
 * rejection cannot surface as an unhandled rejection.
 */
function withDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
  step: string
): Promise<T> {
  const expiry = new Promise<never>((_, reject) => {
    const fail = () =>
      reject(
        new TypeError(
          `CIMD ${step} exceeded the ${FETCH_TIMEOUT_MS}ms budget`
        )
      );
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  return Promise.race([work, expiry]);
}

async function readCapped(response: Response): Promise<Response> {
  if (!response.body) return response;

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new TypeError(
      `metadata response declares Content-Length ${declaredLength}, ` +
        `exceeding the ${MAX_BODY_BYTES}-byte cap`
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new TypeError(
        `metadata response body exceeded the ${MAX_BODY_BYTES}-byte cap`
      );
    }
    chunks.push(value);
  }

  return new Response(chunks.length ? new Blob(chunks) : null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Fallback CIMD transport for Bun. See the file-level comment above for why
 * this exists instead of `@better-auth/cimd/node`'s packaged implementation,
 * and — critically — which of that implementation's SSRF guarantees this
 * does NOT provide (DNS resolve-once / connection pinning).
 */
export const fetchClientMetadataResource: ClientMetadataResourceFetch = async (
  input,
  init
) => {
  const request = new Request(input, init);
  const url = new URL(request.url);

  if (url.protocol !== "https:") {
    throw new TypeError("CIMD fallback transport requires an HTTPS URL");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new TypeError("CIMD fallback transport supports only GET and HEAD");
  }

  // One budget for the whole operation. Created before the DNS lookup so the
  // lookup spends the same 5s the connection and body read draw down.
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  const addresses = await withDeadline(
    lookup(url.hostname, { all: true, verbatim: true }),
    deadline,
    "DNS resolution"
  );
  if (addresses.length === 0) {
    throw new TypeError("metadata hostname returned no DNS addresses");
  }
  for (const { address } of addresses) {
    if (!isPublicRoutableHost(address)) {
      throw new TypeError(
        "metadata hostname must resolve only to public-routable addresses"
      );
    }
  }

  const response = await fetch(url, {
    method: request.method,
    headers: request.headers,
    redirect: "manual",
    signal: deadline,
  });

  return withDeadline(readCapped(response), deadline, "body read");
};
