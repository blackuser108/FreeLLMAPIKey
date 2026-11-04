# FreeLLMAPI Cloud — Vercel Hobby + Supabase Free

This is the cloud chat edition of the existing FreeLLMAPI source. It runs its
**real provider adapters**, not the Electron binary or a mock service. The local
installation is independent and keeps its own database and access key.

Production website: **https://free-llmapi-key-rfvf-ten.vercel.app**

OpenAI Base URL: **https://free-llmapi-key-rfvf-ten.vercel.app/v1**

The public website, real admin login, authenticated database reads, invalid-key
rejection, signed model suggestions and provider-metadata error handling have
been verified on the production URL. A real invalid-key metadata request to
Groq returned a safe 422 and preserved the admin session. This is not inference.
No upstream credential has been transferred from the local installation; the
operator chose manual entry. Real inference remains pending until a free-tier
provider credential/model is added. See `evidence/latest.json` for recorded checks.

## What runs where

- Vercel: management website and one streaming Node.js 24 Function.
- Supabase PostgreSQL: encrypted provider credentials, hashed client API keys,
  quotas, cooldowns, routing order and in-flight leases, in the private
  `freellmapi` schema. Nothing in this schema is exposed to the Supabase Data API.
- AI providers: perform inference using your own credentials. Hosting does not
  supply free inference credits. Add only credentials/model IDs you have checked
  belong to a free tier; OpenRouter models must end in `:free`.

`cloud/src/providers.mjs` imports the original provider implementations from
`server/src/providers/`. Their sampling policies, tool-call repairs, Gemini
conversion, SSE processing and Retry-After handling are reused. The asynchronous
cloud store/router replaces SQLite and process-local orchestration. Original
SQLite helpers referenced by the adapters are **not initialized**: their optional
local quota observations/settings fall back to defaults. Cloud quota enforcement
and management data always use PostgreSQL, never a fake SQLite handle.

## Supported scope and explicit differences

| Feature | Cloud behavior |
|---|---|
| OpenAI chat | `POST /v1/chat/completions`, including tools and supported sampling/JSON options |
| Streaming | SSE chunks, `[DONE]`, backpressure and disconnect cancellation |
| Models | Authenticated `GET /v1/models`; lists configured IDs, not a claim they were live-probed |
| Model setup | Original signed free monthly catalog suggestions, authenticated provider-list discovery, automatic model selection when saving without manual IDs |
| Management tests | Cookie-authenticated chat/SSE playground; no separate cloud key needed; each test is an explicit AI request |
| Routing | `auto`: priority then least recently used; explicit ID never falls back to a different model |
| Fallback | At most 3 credential attempts, only before any stream chunk is sent to the client |
| Provider limits | Shared credential-wide RPM/RPD/TPM/TPD and concurrency in PostgreSQL |
| Health checks | On-demand failure/cooldown; no periodic AI probes |
| Cleanup | Hourly at most, on authenticated requests; old counters/attempts removed after 25h |
| Local data import | Optional read-only tool; no automatic transfer of local credentials |
| Other features | Image/audio/video/search/embeddings, Anthropic/Gemini wire endpoints, Responses, desktop IPC, custom upstream URLs, premium sync, conversation history, client profiles, latency/intelligence routing strategies and local cache are not included |

Provider adapters included: Groq, Cerebras, Google Gemini, NVIDIA NIM, Mistral,
OpenRouter, Hugging Face, Cohere, Cloudflare Workers AI, Zhipu and LLMTr. A provider
being supported does not prove a particular account, model, free tier or region
currently works. The management screen reports each route's last HTTP status.

## API use from another cloud project

Use the **cloud** key, obtained after admin sign-in → “Khóa truy cập cloud” →
“Tạo khóa mới”. Each new key is shown once and stored only as a SHA-256 digest.
Use separate keys per project; revoke keys individually. The initial key and
admin password are handed over privately in `.cloud-private/ACCESS.txt`.

Add these variables to the **server environment** of the calling project:

```dotenv
FREELLMAPI_BASE_URL=https://YOUR-DEPLOYMENT.vercel.app/v1
FREELLMAPI_API_KEY=YOUR_NEW_CLOUD_ACCESS_KEY
```

Never use `NEXT_PUBLIC_` or `VITE_` for an API key. Never commit actual `.env`
files. Redeploy the calling project after setting its environment variables.

```js
// Server-only route / worker in the CALLING project.
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: process.env.FREELLMAPI_BASE_URL,
  apiKey: process.env.FREELLMAPI_API_KEY,
});
const result = await client.chat.completions.create({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 256,
});
```

```bash
curl "$FREELLMAPI_BASE_URL/models" \
  -H "Authorization: Bearer $FREELLMAPI_API_KEY"

curl "$FREELLMAPI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $FREELLMAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'

curl -N "$FREELLMAPI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $FREELLMAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}],"max_tokens":64,"stream":true}'
```

An explicit model may be `groq/openai/gpt-oss-20b` or its configured upstream
ID. Use the IDs returned by `/v1/models`. `auto` chooses any enabled eligible
route and may fall back to another configured model.

Errors use `{ "error": { "message": "...", "type": "...", "request_id": "..." } }`.
401 means a missing/invalid cloud key, 429 means a shared cap/cooldown/concurrency
limit, 503 means incomplete configuration/no enabled routes/unavailable database,
502 means failed upstream attempts, and 504 means the gateway time budget ended.
A mid-stream failure emits an SSE error without `[DONE]`; retry the whole request.
There is no attempt to merge output from different providers after streaming starts.

## Management and security

1. Open the deployed website and sign in with the privately supplied password.
2. Add a provider key; leave model IDs blank for automatic discovery, or use
   “Kiểm tra khóa & lấy model” before saving. Manual IDs remain available when
   you have independently confirmed free access. Set limits at or below those of
   your actual account. Defaults are conservative application guardrails, not
   verified provider entitlements. Shared accounts across local/cloud installs
   also share the provider's actual allowance.
3. Create a cloud client key and place it in each calling project's server env.
4. Use the playground only when you intend to send real AI requests.

Model discovery reads metadata only. `POST /api/providers/discover` checks a
submitted key against the provider's model API where supported; it does not save
the key or generate tokens. A rejected upstream key returns **422** with
`provider_auth_error`, not an admin-session 401. `POST /api/providers/refresh`
uses the saved encrypted credential and adds discovered models while preserving
manual entries. Both require an admin cookie and same-origin request.
`POST /api/playground` uses the same router, quotas, adapters and SSE pipeline as
the public API, authenticated with the admin cookie instead of a client key.

`catalog.json` is a snapshot of the original **public monthly** FreeLLMAPI
catalog. `npm --prefix cloud run catalog:update` verifies the original pinned
Ed25519 signature before replacing it; it sends no provider key or license.
The source/version is shown in the UI. Refresh the snapshot, review the diff,
then rebuild/redeploy to publish a newer catalog. There is no background catalog
sync or periodic AI probe in this edition. Some providers may have no enabled
rows in the signed free catalog; manual IDs require checking your actual free
entitlements. Provider metadata is intersected with this catalog (or explicit
zero-price metadata) to avoid auto-selecting paid models. LLMTr forbids automatic
key checks and uses signed catalog suggestions; discovery reports **unchecked**.
An explicit chat records the last inference HTTP status separately. A successful
model-list GET is not AI verification.

The admin session is a signed, 12-hour `__Host-` cookie with HttpOnly, Secure and
SameSite=Strict. Browser writes require an exact same Origin. No passwords,
sessions or API credentials are stored in localStorage. New upstream credentials
are encrypted with AES-256-GCM before SQL storage; the encryption key lives in
Vercel's secret environment variables, not in PostgreSQL or frontend assets.
Logs contain request IDs and classifications, not SQL parameters, prompts,
upstream error bodies or credentials. Generic errors hide internal details.
Only built-in provider destinations are allowed; custom URLs are rejected.

The runtime database role has CRUD rights only in this application's private
schema, no schema-creation or elevated rights. Tables have RLS restricted to that
role; `anon`, `authenticated` and PUBLIC have no schema/table access. TLS verifies
Supabase's CA chain and hostname. The committed CA is public, downloaded from the
certificate link in the official project dashboard.

## Concurrency and conservative accounting

Each candidate is locked with `FOR UPDATE SKIP LOCKED` in a short transaction.
The same transaction checks minute/day counts, token reservations, unexpired
leases and cooldown, then inserts the new lease **before** inference starts.
This prevents double-spending quota between separate serverless instances.
RPM/RPD count all attempts, including failures. Windows are rolling 60 seconds /
24 hours, intentionally stricter than some providers' calendar resets.

Token reservation uses UTF-8 request bytes, message overhead and output limit.
On success, a reported total token count replaces the reservation. Missing usage,
failed requests and crashed functions retain the reservation conservatively until
the quota window expires. A crashed lease expires after 275 seconds for concurrency;
it does not erase recorded quota. This favors avoiding overspend over utilization.
Short simultaneous transactions can return 429 if all candidate rows are locked;
clients should back off. Native provider quota dashboards/history are not copied.

## Free-tier limits checked on 2026-11-04

- Vercel Hobby / Fluid Compute: function ceiling 300 seconds. This build declares
  300s, sets a 250s application deadline and normally 60s per upstream attempt.
- Requests are capped at 1 MiB here; non-streaming responses at 4 MiB. Vercel's
  documented payload ceiling is 4.5 MB. No image-token accounting is claimed.
- Maximum output is 4096 tokens, default 1024. At most 3 attempts per request.
- Default 20 requests/minute/client key; shared guardrails 1000 authenticated
  API calls/24h, 300 auth attempts/minute and 10 admin sign-in attempts/15min.
  Listing models also consumes the gateway request budgets.
- Supabase Free: 500 MB DB, 5 GB egress, 2 active projects; projects may pause after
  one week of inactivity. Vercel/Supabase free quotas can suspend service. A fixed
  URL and laptop independence do not constitute a paid uptime guarantee.
- No subscription, paid resource, background inference, or automatic upgrade is
  enabled. The app does not purchase credits or bypass provider limits.

Sources: [Vercel limits](https://vercel.com/docs/functions/limitations),
[Supabase pricing](https://supabase.com/pricing),
[Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres),
[SSL verification](https://supabase.com/docs/guides/platform/ssl-enforcement),
[Build Output API](https://vercel.com/docs/build-output-api).

## Local development, build and deployment

Node 24 and npm are required. From repository root:

```bash
npm ci --ignore-scripts
npm --prefix cloud ci --ignore-scripts
npm --prefix cloud run build
npm --prefix cloud test
```

The cloud build uses separate pinned dependencies and lockfile. Zod and fast-uri
are explicitly resolved to patched cloud versions, including imports made by the
original adapters. Native SQLite and image modules are not installed/executed by
this build. Vercel receives one bundled function and static HTML/CSS/JS via the
Build Output API. `vercel.json` selects this build rather than the desktop/full
monorepo build that previously looked for a nonexistent root `dist` directory.

For a new database, apply `cloud/schema.sql` once in a dedicated Supabase project.
Create a login role `freellmapi_runtime` with a strong generated password, grant
CONNECT, USAGE on schema `freellmapi`, CRUD on its tables, and an RLS policy for
that role on each table. Do not grant privileges to browser/anon roles.
Use the exact transaction-pooler hostname from Supabase's Connect dialog, port
6543 and username `freellmapi_runtime.PROJECT_REF`. The `pg` driver uses unnamed
parameterized statements and one connection per instance, with pipelining off.
Transactions acquire one client for their entire BEGIN/COMMIT/ROLLBACK sequence.
The cloud query tag only converts interpolated values to `$n` parameters; it does
not rewrite SQL. The first Postgres.js implementation hung on concurrent
management reads and was replaced; regression tests cover that exact scenario.
Database operations have a 12s wall-clock ceiling, after which the connection is
discarded and the request fails closed, allowing a new connection next time.

Set the four variables in `cloud/.env.example` as Vercel **server secrets**:
`DATABASE_URL`, `CLOUD_ENCRYPTION_KEY`, `CLOUD_SESSION_SECRET`,
`CLOUD_ADMIN_PASSWORD_HASH`. Encryption and session keys should be independent
32-byte random values, hex encoded. The admin hash is `salt:hash` with 16-byte
hex salt and Node `scryptSync(password,salt,64)` as hex. Never rotate the encryption
key without re-encrypting existing provider rows. Losing it makes them unreadable.

For this checkout, generated private local config lives under `.cloud-private/`;
it is gitignored and restricted to the owning Windows account and SYSTEM.
The bootstrap helper refuses to overwrite existing credentials. For another
project, adapt its project reference and verified pooler hostname before use.

```bash
# Uses the privately provisioned DB and new cloud encryption key.
npm --prefix cloud run test:database
npm --prefix cloud run dev
```

The HTTP dev server is only for API/transport testing. Admin login intentionally
requires HTTPS because production uses Secure cookies; use the Vercel deployment
for management. The dev server never contacts a provider at startup.

Push the reviewed commit, then deploy the linked Vercel project. Production must
be publicly reachable so server clients can authenticate with the cloud key;
preview deployments may keep Vercel login protection. Keep the gateway's own
admin and API authentication enabled. Use the stable production alias, not a
commit-specific preview URL, for client Base URLs.

## Moving configuration from local

The current user chose **manual key entry** on the cloud management page. No
local upstream credential was transferred. You can reuse an upstream free-tier
key after entering it securely; the cloud access key is newly issued and differs
from the local FreeLLMAPI access key. Local sessions/cookies are not transferred.

The optional `cloud/scripts/import-local.mjs` supports future operator-authorized
migrations. Default mode is a dry run. Applying requires both `--apply` and
`--confirm-free`, the local encryption key file and cloud env. It reads SQLite
read-only, decrypts in memory, re-encrypts with the cloud key, and never prints
credential values. Existing deterministic import IDs are skipped rather than
overwritten. It skips custom URLs, search-only providers, paid catalog models,
missing model lists and per-key restrictions it cannot preserve. It does not
copy access keys, accounts, conversations, historical quota or cooldown data.
Review the metadata-only report before authorizing any transfer.

## Verification levels

1. **Build/deploy:** bundle and static UI exist and deployment is READY.
2. **Live API/security/DB:** independent HTTP client tests wrong key, admin gate,
   configured model list, input rejection, shared database state.
3. **Real AI:** only after a valid free-tier provider credential is present,
   call chat and SSE against the PUBLIC URL. Verify actual content, stream chunks
   and `[DONE]`; distinguish provider failure from a passing health check.

`npm --prefix cloud test` uses real original adapters against a fake local
upstream. `test:database` checks real Supabase transactions using isolated UUID
rows removed afterward. Neither constitutes a real paid/free AI inference test.

Cloud dependency audit is separate from the legacy monorepo audit. The cloud
bundle includes node-postgres, patched zod/fast-uri and the original adapter's AJV
helpers; unrelated legacy Express/Vite/CLI/media advisories are not claimed fixed.
Review and patch the full monorepo separately before exposing other surfaces.

Original FreeLLMAPI copyright and MIT license in the repository remain in force.
