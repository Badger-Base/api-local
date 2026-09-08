# MCP Server Spike — Findings

Spike performed in a throwaway scratch directory (not committed) against the
exact pinned versions:

```
better-auth@1.7.2
@better-auth/mcp@1.7.2
@better-auth/cimd@1.7.2
@modelcontextprotocol/sdk@1.30.0
```

All four installed cleanly at the pinned versions with `bun add` (no
substitutions were needed — this is not a finding, just confirmation the
constraint is satisfiable).

**Notable transitive dependency (unpinned):** `@better-auth/mcp@1.7.2` pulls
in `@better-auth/oauth-provider@1.7.3` as a transitive dependency. That
package — not `@better-auth/mcp` or `better-auth` core — is where nearly all
of the load-bearing logic for Questions 1 and 4 actually lives (`mcp()` is a
thin wrapper around `oauthProvider()`). It is not one of the four pinned
packages in the plan's constraint, so a future `bun install` could silently
pick up a newer `@better-auth/oauth-provider` unless it's added to the pin
list or a lockfile is committed. Flagging this for whoever writes Task 6-8's
dependency setup.

---

## Question 1 — Can `loginPage`/`consentPage` be absolute URLs?

**Asked:** BadgerBase's login UI lives on `badgerbase.app` (Next.js), while
the authorization server is this same Hono API, deployed at its own public
host (a different origin from the frontend — its exact hostname is whatever
`BETTER_AUTH_URL` is set to in that environment). Does the plugin
resolve `loginPage`/`consentPage` as paths relative to the auth server's own
`baseURL`, or does it accept (and correctly redirect to) an absolute URL on a
different origin?

**Answer: absolute URLs are accepted and used verbatim.** Whatever string is
configured for `loginPage`/`consentPage` is used as the start of the
`Location` header value with no `new URL(path, baseURL)` resolution and no
origin prefixing anywhere in the redirect path. Task 8 does **not** need to
have the API host proxy `/login`/`/consent` to the frontend — it can point
`loginPage`/`consentPage` straight at
`https://badgerbase.app/login` / `https://badgerbase.app/consent`.

**Evidence — this was not ambiguous, so no empirical fallback was strictly
required, but one was run anyway for extra confidence (see below).**

1. `@better-auth/mcp` itself does not implement `loginPage`/`consentPage` at
   all — it only appears in a JSDoc `@example` comment in
   `node_modules/@better-auth/mcp/dist/index.mjs` (lines 157-158). The `mcp()`
   function passes the option straight through to `oauthProvider()`:

   `node_modules/@better-auth/mcp/dist/index.mjs:172-177`
   ```js
   const provider = oauthProvider({
     refreshTokenReuseInterval,
     ...oauthOptions,
     resources: appendProtectedResource(oauthOptions.resources, resource),
     clientRegistrationDefaultResources: appendResourceIdentifier(oauthOptions.clientRegistrationDefaultResources, resource)
   });
   ```

   So the real implementation is in `@better-auth/oauth-provider`
   (installed transitively at `1.7.3` — see note above).

2. The redirect target is built in
   `node_modules/@better-auth/oauth-provider/dist/authorize-9whjxVLJ.mjs`,
   function `redirectWithPromptCode` (lines 5731-5743):

   ```js
   async function redirectWithPromptCode(ctx, opts, type, options) {
     const queryParams = await signParams(ctx, opts, { postLoginClearedForSession: type === "consent" && opts.postLogin ? options?.sessionId : void 0 });
     let path = opts.loginPage;
     if (type === "select_account") path = opts.selectAccount?.page ?? opts.loginPage;
     else if (type === "post_login") { ... }
     else if (type === "consent") path = opts.consentPage;
     else if (type === "create") path = opts.signup?.page ?? opts.loginPage;
     return handleRedirect(ctx, `${options?.page ?? path}?${queryParams}`);
   }
   ```

   The load-bearing line is:
   ```js
   return handleRedirect(ctx, `${options?.page ?? path}?${queryParams}`);
   ```
   This is a plain template-string concatenation of `path` (i.e.
   `opts.loginPage`/`opts.consentPage`, verbatim, whatever string was
   configured) with a `?`-prefixed query string. There is no `new URL(path,
   ctx.baseURL)`, `resolve()`, or any other step that would anchor a relative
   path to the auth server's origin, or that would strip/rewrite an absolute
   origin already present in `path`.

3. `handleRedirect` (same file, lines 5330-5337) just forwards that string to
   `ctx.redirect(uri)`:
   ```js
   const handleRedirect = (ctx, uri) => {
     const fromFetch = isBrowserFetchRequest(ctx.request?.headers);
     const acceptJson = ctx.headers?.get("accept")?.includes("application/json");
     if (fromFetch || acceptJson) return { redirect: true, url: uri.toString() };
     else throw ctx.redirect(uri);
   };
   ```

4. `ctx.redirect` comes from `better-call` (the HTTP layer `better-auth`
   is built on), `node_modules/better-call/dist/context.mjs:60-63`:
   ```js
   redirect: (url) => {
     headers.set("location", url);
     return new APIError("FOUND", void 0, headers);
   },
   ```
   This sets the `Location` header to the exact string it was given —
   `headers.set("location", url)` — with no parsing, no `new URL()`, no origin
   substitution. An absolute URL passed in survives unchanged as the
   `Location` header value.

   Chain: `opts.loginPage` → `redirectWithPromptCode` (string concat only) →
   `handleRedirect` → `ctx.redirect(url)` → `headers.set("location", url)`.
   No hop in that chain can turn an absolute URL into anything else, and none
   of them require the value to be relative either.

**Empirical check (supplementary):** I also drove `auth.handler` directly at
`/api/auth/oauth2/authorize` with `loginPage`/`consentPage` set to
`https://badgerbase.app/login` / `.../consent`. An unauthenticated request
with a synthetic (unregistered) `client_id` gets rejected before it ever
reaches the login/consent redirect — client validation happens first, and the
provider intentionally returns a generic
`.../api/auth/error?error=invalid_client&error_description=client_id+is+required`
redirect rather than reaching the `loginPage`/`consentPage` branch at all
(this looks like deliberate "don't leak whether a client exists" behavior,
not a bug). Reaching the actual `loginPage`/`consentPage` redirect requires a
client registered through the database (dynamic client registration itself
requires authentication in this version, so it also needs a seeded session or
admin credential). Doing that is out of scope for a DB-less spike per the
task's constraint ("the `betterAuth()` call ... needs no database"), so this
was not pursued further — the source-level evidence above (item 1-4) is
unambiguous and was treated as sufficient. **This is the one place the
answer rests on static-code reading rather than an observed `Location`
header; flagged for anyone who wants to double-check with a real DB before
Task 8 ships.**

---

## Question 2 — Which discovery endpoints does the plugin actually serve?

**Asked:** confirm the exact set of paths and status codes so Task 9's
assertions target real endpoints.

**Answer (from running the brief's `spike.ts` against a DB-less
`betterAuth()` instance with `jwt()` + `mcp({ loginPage: "/login",
consentPage: "/consent", resource: "http://localhost:3999/mcp" })`):**

| Path | Status |
|---|---|
| `/.well-known/oauth-protected-resource` | `200` |
| `/.well-known/oauth-authorization-server` | `404` |
| `/api/auth/.well-known/oauth-authorization-server` | `200` |
| `/api/auth/jwks` | `200` |

Command run:
```bash
bun run spike.ts
```
(script identical to the one in the task brief, `baseURL:
"http://localhost:3999"`, no database configured).

**Note for Task 9:** the unprefixed `/.well-known/oauth-authorization-server`
returns `404` — only the version under the auth mount path
(`/api/auth/.well-known/oauth-authorization-server`) is served. The
protected-resource metadata (`/.well-known/oauth-protected-resource`), by
contrast, is served unprefixed at the root, not under `/api/auth`. If the
real deployment changes `basePath` from the default `/api/auth`, or if
something in front of the Hono app (e.g. a reverse proxy) is expected to
serve `/.well-known/oauth-authorization-server` at the bare root per RFC
8414's well-known convention, that gap needs to be handled explicitly —
`better-auth`/`@better-auth/mcp` does not itself serve it there.

---

## Question 3 — `fetchClientMetadataResource` contract

**Asked:** exact signature and return type, for Task 7's implementation.

**Answer:**

```ts
type ClientMetadataResourceFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Awaitable<Response>;
```

where `type Awaitable<T> = Promise<T> | T;`

Source: `node_modules/@better-auth/oauth-provider/dist/oauth-1Ud-hvZY.d.mts:697`
(re-exported through `@better-auth/cimd/dist/index.d.mts:1,78` as
`fetchClientMetadataResource: ClientMetadataResourceFetch`, and via
`@better-auth/cimd/dist/node.d.mts:13` as a ready-made
`fetchClientMetadataResource` implementation for Node).

Command run:
```bash
grep -n -B 6 -A 10 "fetchClientMetadataResource" node_modules/@better-auth/cimd/dist/*.d.mts
grep -rn "ClientMetadataResourceFetch" node_modules/@better-auth/oauth-provider/dist/*.d.mts
```

The contract is intentionally identical in shape to the global `fetch`
function — `(input: RequestInfo | URL, init?: RequestInit) => Awaitable<Response>`
— so a plain `fetch` reference satisfies the type, but the field's doc
comment (`@better-auth/cimd/dist/index.d.mts:72-77`) specifies stricter
runtime requirements the implementation must actually meet:

> The transport MUST resolve the hostname exactly once, reject RFC 6890
> special-use addresses, pin the approved address for the connection, and
> refuse redirects. Those guarantees cannot be implemented by wrapping the
> standard Fetch API after DNS resolution, so the application must provide
> them at its runtime-specific network boundary.

`@better-auth/cimd` ships a ready-made Node implementation satisfying this at
`@better-auth/cimd/node` (`fetchClientMetadataResource`,
`node_modules/@better-auth/cimd/dist/node.d.mts:13`) — Task 7 should use that
export directly rather than hand-rolling a `fetch` wrapper, since a naive
wrapper cannot satisfy the DNS-pinning/no-redirect requirements per the
comment above.

---

## Unresolved / flagged for later tasks

1. **Question 1's empirical leg is incomplete** (see above) — the answer is
   based on unambiguous source reading across 4 call sites, not an observed
   `Location` header from a full authorize flow with a real registered
   client. **Disposition:** accepted as-is by the plan owner; the live
   confirmation is scheduled into Task 10's live verification instead of
   being re-attempted here.
2. **`@better-auth/oauth-provider` is an unpinned transitive dependency**
   carrying most of the OAuth-provider logic (currently resolves to
   `1.7.3`). It is not one of the four packages the plan's constraint pins
   exactly. **Disposition:** no action needed — `bun.lock` is tracked in
   this repo, so the transitive resolution is pinned by the lockfile once
   installed. Whichever task runs the real `bun install` must commit the
   resulting lockfile change.
3. ~~`/.well-known/oauth-authorization-server` is not served at the bare
   root~~ — **resolved, not a gap.** See "Question 4" above: a
   spec-conforming client deriving the metadata URL from
   `authorization_servers[0]` via either RFC 8414 path-insertion
   (`/.well-known/oauth-authorization-server/api/auth`) or the OIDC-style
   path-append (`/api/auth/.well-known/oauth-authorization-server`) gets a
   `200` from both — the plugin explicitly serves both derived paths keyed
   off the issuer's path component. The bare-root `404` from Question 2 was
   never a path any spec-conforming client would construct for this issuer,
   so no alias route is needed in Task 9.

---

## Question 4 (follow-up) — Does a spec-conforming client actually land on a 200?

**Asked:** Question 2 found `/.well-known/oauth-authorization-server` is `404`
at the bare root and `200` only under `/api/auth`. Does that matter? It
depends on the advertised issuer: if an MCP client fetches
`/.well-known/oauth-protected-resource`, follows `authorization_servers[0]`,
and applies the RFC 8414 path-insertion transform to it, does it land on a
`200`?

**Answer: yes.** Both the RFC 8414 path-insertion form and the OIDC-style
path-append form resolve to `200` for this issuer. No alias route is needed
in Task 9 — this is not a gap.

**Evidence.** Same DB-less `betterAuth()` setup as Step 3 (`baseURL:
"http://localhost:3999"`, `jwt()` + `mcp({ loginPage: "/login", consentPage:
"/consent", resource: "http://localhost:3999/mcp" })`).

1. `/.well-known/oauth-protected-resource` full body:
   ```json
   {"resource":"http://localhost:3999/mcp","authorization_servers":["http://localhost:3999/api/auth"],"bearer_methods_supported":["header"],"dpop_signing_alg_values_supported":["EdDSA","ES256","ES512","PS256","RS256"]}
   ```
   `authorization_servers[0]` = `http://localhost:3999/api/auth`.

2. `/api/auth/.well-known/oauth-authorization-server` full body (`issuer`
   highlighted):
   ```json
   {"scopes_supported":["openid","profile","email","offline_access"],"issuer":"http://localhost:3999/api/auth","authorization_endpoint":"http://localhost:3999/api/auth/oauth2/authorize","token_endpoint":"http://localhost:3999/api/auth/oauth2/token","jwks_uri":"http://localhost:3999/api/auth/jwks","introspection_endpoint":"http://localhost:3999/api/auth/oauth2/introspect","revocation_endpoint":"http://localhost:3999/api/auth/oauth2/revoke","response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","client_credentials","refresh_token"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","private_key_jwt"],"token_endpoint_auth_signing_alg_values_supported":["RS256","RS384","RS512","PS256","PS384","PS512","ES256","ES384","ES512","EdDSA"],"introspection_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","private_key_jwt"],"introspection_endpoint_auth_signing_alg_values_supported":["RS256","RS384","RS512","PS256","PS384","PS512","ES256","ES384","ES512","EdDSA"],"revocation_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","private_key_jwt"],"revocation_endpoint_auth_signing_alg_values_supported":["RS256","RS384","RS512","PS256","PS384","PS512","ES256","ES384","ES512","EdDSA"],"code_challenge_methods_supported":["S256"],"authorization_response_iss_parameter_supported":true,"dpop_signing_alg_values_supported":["EdDSA","ES256","ES512","PS256","RS256"],"backchannel_logout_supported":true,"backchannel_logout_session_supported":true,"claims_supported":["sub","iss","aud","exp","iat","sid","scope","azp","name","picture","given_name","family_name","email","email_verified"],"claims_parameter_supported":true,"userinfo_endpoint":"http://localhost:3999/api/auth/oauth2/userinfo","subject_types_supported":["public"],"acr_values_supported":["0"],"id_token_signing_alg_values_supported":["EdDSA"],"end_session_endpoint":"http://localhost:3999/api/auth/oauth2/end-session","request_parameter_supported":false,"request_uri_parameter_supported":false,"prompt_values_supported":["login","consent","create","select_account","none"]}
   ```
   `issuer` = `http://localhost:3999/api/auth`.

3. Given `issuer = http://localhost:3999/api/auth` (issuer path = `/api/auth`),
   the two client-derived paths and their observed status:

   | Derivation | Path | Status |
   |---|---|---|
   | RFC 8414 path-insertion: `/.well-known/oauth-authorization-server<issuer-path>` | `/.well-known/oauth-authorization-server/api/auth` | **200** |
   | OIDC-style path-append: `<issuer-path>/.well-known/oauth-authorization-server` | `/api/auth/.well-known/oauth-authorization-server` | **200** |
   | (for contrast) bare root, no issuer path | `/.well-known/oauth-authorization-server` | 404 |

   The `200` for the path-insertion form returns the identical metadata body
   as item 2 above (verified by content, not just status — a garbage suffix
   appended past `/api/auth` correctly 404s, confirming this is an exact
   route match rather than a wildcard catch-all swallowing everything).

4. This is deliberate, not incidental. `@better-auth/oauth-provider`
   explicitly builds and checks both derivations from the issuer path:
   `node_modules/@better-auth/oauth-provider/dist/authorize-9whjxVLJ.mjs:4227-4237`,
   function `handleIssuerMetadataRequest`:
   ```js
   let issuerPath = "/";
   try {
     issuerPath = new URL(issuer).pathname.replace(/\/$/, "") || "";
   } catch {
     issuerPath = new URL(ctx.baseURL).pathname.replace(/\/$/, "") || "";
   }
   ...
   const authServerMetadataPaths = new Set([`/.well-known/oauth-authorization-server${issuerPath}`, `${issuerPath}/.well-known/oauth-authorization-server`]);
   ```
   Both entries in that `Set` are checked against the incoming request path;
   either one is served with the same metadata. The `404` seen in Question 2
   for the *bare* `/.well-known/oauth-authorization-server` (no issuer-path
   suffix) is expected and correct — it is neither of the two paths a
   spec-conforming client would ever derive from an issuer that has a
   non-empty path component (`/api/auth`), so it isn't a gap.

**Conclusion for Task 9 / Task 10:** no alias route is needed. As long as
the real deployment's issuer is `<baseURL>/api/auth` — that is, whatever
public origin `BETTER_AUTH_URL` resolves to for that environment, plus the
default `/api/auth` mount, with no `jwt().options.jwt.issuer` override
pointing elsewhere — a spec-conforming MCP client that starts from
`authorization_servers[0]` and applies RFC 8414 path-insertion will land on
`<baseURL>/.well-known/oauth-authorization-server/api/auth`, which resolves
`200`. Task 9's assertions should include this exact path (in addition to
the `/api/auth/.well-known/...` one from Question 2) since both are real,
intentionally-served routes.

