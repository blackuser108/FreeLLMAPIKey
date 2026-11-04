import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.mjs';
import { chatSchema, providerSchema, tokenReservation, HttpError, readJson } from './validation.mjs';
import { cookieToken, decrypt, encrypt, secureHeaders, signSession, validSession, verifyPassword } from './security.mjs';
import { providerFor } from './providers.mjs';

function send(res, status, data) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
function bounded(value, fallback, min, max) {
  const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
function bearer(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  return match?.[1];
}
function sameOrigin(req) {
  // Browsers must supply an Origin for mutations. Host is supplied by Vercel;
  // forwarded headers from the caller are deliberately ignored here.
  return req.headers.origin === `https://${req.headers.host}`;
}
async function writeSse(res, value, signal) {
  if (signal.aborted || res.destroyed) throw new HttpError(499, 'Client disconnected');
  if (res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`)) return;
  await new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new HttpError(499, 'Client disconnected')); };
    const cleanup = () => { res.off('drain', done); res.off('close', closed); signal.removeEventListener('abort', closed); };
    res.once('drain', done); res.once('close', closed); signal.addEventListener('abort', closed, { once: true });
    if (signal.aborted || res.destroyed) closed();
  });
}
export function createHandler({ makeStore = () => new Store(), makeProvider = providerFor, env = process.env } = {}) {
  return async function handler(req, res) {
    secureHeaders(res);
    const requestId = randomUUID(); res.setHeader('X-Request-Id', requestId);
    const controller = new AbortController();
    const deadlineMs = bounded(env.CLOUD_REQUEST_TIMEOUT_MS, 250000, 1000, 250000);
    const deadline = setTimeout(() => controller.abort(new Error('Gateway deadline')), deadlineMs);
    const onDisconnect = () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected')); };
    res.once('close', onDisconnect); req.once('aborted', onDisconnect);
    let route = null; let store; let iterator;
    try {
      const path = new URL(req.url, 'https://gateway.invalid').pathname;
      if (path === '/api/health' && req.method === 'GET') {
        // Liveness is deliberately distinct from authenticated DB readiness.
        return send(res, 200, { service: 'FreeLLMAPI Cloud', version: '1', inferenceVerified: false, configured: !!env.DATABASE_URL });
      }
      if (!env.DATABASE_URL || !env.CLOUD_SESSION_SECRET || !env.CLOUD_ENCRYPTION_KEY || !env.CLOUD_ADMIN_PASSWORD_HASH) throw new HttpError(503, 'Cloud configuration is incomplete', 'configuration_error');
      store = makeStore();
      if (path.startsWith('/api/')) {
        if (path === '/api/login' && req.method === 'POST') {
          if (!sameOrigin(req)) throw new HttpError(403, 'Same-origin browser request required', 'permission_error');
          // Global shared login budget, not spoofable forwarded-IP counters.
          if (!await store.limit('admin-login', 10, 900)) throw new HttpError(429, 'Login temporarily limited', 'rate_limit_error', 900);
          const body = z.object({ password: z.string().max(256) }).strict().parse(await readJson(req, 2048));
          if (!verifyPassword(body.password, env.CLOUD_ADMIN_PASSWORD_HASH)) throw new HttpError(401, 'Invalid password', 'authentication_error');
          res.setHeader('Set-Cookie', `__Host-freellmapi=${signSession(env.CLOUD_SESSION_SECRET)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
          return send(res, 200, { ok: true });
        }
        if (!validSession(cookieToken(req), env.CLOUD_SESSION_SECRET)) throw new HttpError(401, 'Sign in to manage this gateway', 'authentication_error');
        if (req.method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'Same-origin browser request required', 'permission_error');
        if (!await store.limit('admin-requests', 120)) throw new HttpError(429, 'Admin request limit reached', 'rate_limit_error', 60);
        if (path === '/api/logout' && req.method === 'POST') {
          res.setHeader('Set-Cookie', '__Host-freellmapi=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
          return send(res, 200, { ok: true });
        }
        if (path === '/api/state' && req.method === 'GET') {
          await store.maintenance();
          const [providers, keys, stats] = await Promise.all([store.providers(), store.accessKeys(), store.stats()]);
          return send(res, 200, { providers, keys, stats, apiBase: '/v1', database: 'connected', limits: { requestSeconds: deadlineMs / 1000, maxAttempts: bounded(env.CLOUD_MAX_ATTEMPTS,3,1,3), maxOutputTokens:4096 } });
        }
        if (path === '/api/providers' && req.method === 'POST') {
          const body = providerSchema.parse(await readJson(req, 100000));
          if (body.platform === 'openrouter' && body.models.some(m => !m.endsWith(':free'))) throw new HttpError(400, 'Cloud OpenRouter routes must use :free model IDs');
          const out = await store.addProvider(body, encrypt(body.key, env.CLOUD_ENCRYPTION_KEY));
          return send(res, 201, { id: out.id });
        }
        if (path === '/api/providers/toggle' && req.method === 'POST') {
          const body = z.object({ id: z.string().uuid(), enabled: z.boolean() }).strict().parse(await readJson(req, 2048));
          await store.toggleProvider(body.id, body.enabled); return send(res, 200, { ok: true });
        }
        if (path === '/api/keys' && req.method === 'POST') {
          const { label } = z.object({ label: z.string().trim().min(1).max(80) }).strict().parse(await readJson(req, 2048));
          const key = `freellmapi-${randomBytes(32).toString('hex')}`;
          const out = await store.addAccessKey(label, key); return send(res, 201, { id: out.id, key });
        }
        if (path === '/api/keys/revoke' && req.method === 'POST') {
          const { id } = z.object({ id: z.string().uuid() }).strict().parse(await readJson(req, 2048));
          await store.revokeAccessKey(id); return send(res, 200, { ok: true });
        }
        throw new HttpError(404, 'Unknown management endpoint');
      }
      if (path !== '/v1/models' && path !== '/v1/chat/completions') throw new HttpError(404, 'Supported endpoints: GET /v1/models, POST /v1/chat/completions');
      // Invalid keys never reach provider selection or upstream transport.
      if (!bearer(req)) throw new HttpError(401, 'API key required', 'authentication_error');
      if (!await store.limit('auth-attempts', 300)) throw new HttpError(429, 'Authentication request limit reached', 'rate_limit_error',60);
      const identity = await store.authenticate(bearer(req));
      if (!identity) throw new HttpError(401, 'Invalid API key', 'authentication_error');
      const rpm = bounded(env.CLOUD_API_RPM,20,1,120);
      if (!await store.limit(`api:${identity}`,rpm)) throw new HttpError(429, 'API request limit reached', 'rate_limit_error',60);
      if (!await store.limit('gateway-daily',1000,86400)) throw new HttpError(429, 'Gateway daily request budget reached', 'rate_limit_error',3600);
      if (path === '/v1/models' && req.method === 'GET') {
        const ids = await store.models();
        return send(res,200,{ object:'list', data:[...(ids.length ? ['auto'] : []), ...ids].map(id=>({ id, object:'model', created:0, owned_by:'freellmapi-cloud' })) });
      }
      if (path !== '/v1/chat/completions' || req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = chatSchema.parse(await readJson(req));
      const started = Date.now(); const excluded = [];
      for (let attempt=0; attempt<bounded(env.CLOUD_MAX_ATTEMPTS,3,1,3); attempt++) {
        if (controller.signal.aborted || Date.now()-started > deadlineMs-1000) throw new HttpError(504,'Gateway time budget exceeded','timeout_error');
        route = await store.reserve(body.model,tokenReservation(body),excluded);
        if (!route) {
          const configured = await store.models();
          if (!configured.length) throw new HttpError(503,'Add a free-tier provider key and model in the management page','configuration_error');
          if (body.model !== 'auto' && !configured.some(id=>id===body.model || id.endsWith('/'+body.model))) throw new HttpError(404,'Model is not configured','model_not_found');
          throw new HttpError(429,'All matching routes are busy, cooling down, or at their configured quota','rate_limit_error',60);
        }
        excluded.push(route.id);
        const provider = makeProvider(route.platform);
        const secret = decrypt(route.secret, env.CLOUD_ENCRYPTION_KEY);
        const options = { ...body, max_tokens:body.max_tokens || body.max_completion_tokens || 1024, signal:controller.signal,
          timeoutMs:Math.max(1000,Math.min(60000,deadlineMs-(Date.now()-started)-1000)) };
        try {
          if (!body.stream) {
            const result = await provider.chatCompletion(secret,body.messages,route.model,options);
            if (result.error || !Array.isArray(result.choices)) throw new Error('Invalid upstream completion');
            await store.finish(route,200,result.usage?.total_tokens); route=null;
            const bytes = Buffer.byteLength(JSON.stringify(result));
            if (bytes > 4*1024*1024) throw new HttpError(502,'Upstream response is too large','upstream_error');
            return send(res,200,result);
          }
          iterator = provider.streamChatCompletion(secret,body.messages,route.model,options);
          // Keep headers uncommitted until the REAL adapter yields. A provider
          // failing before its first chunk can safely fall back to another key.
          let next = await iterator.next();
          if (next.done) throw new Error('Empty upstream stream');
          if (next.value.error) throw new Error('Upstream stream error');
          res.statusCode=200; res.setHeader('Content-Type','text/event-stream; charset=utf-8');
          res.setHeader('X-Accel-Buffering','no');
          let usage = null;
          while (!next.done) {
            // Some original adapters yield an upstream error object before
            // throwing. Never relay its raw message (may contain credentials).
            if (next.value.error) throw new Error('Upstream stream error');
            if (next.value.usage?.total_tokens != null) usage=next.value.usage.total_tokens;
            await writeSse(res,next.value,controller.signal);
            next=await iterator.next();
          }
          await store.finish(route,200,usage); route=null;
          await writeSse(res,'[DONE]',controller.signal); return res.end();
        } catch (error) {
          if (route) {
            const status=controller.signal.aborted ? 504 : (Number.isInteger(error.status) ? error.status : 502);
            const delay=status===429 ? Math.max(60000,error.retryAfterMs || 0) : ([401,402,403].includes(status) ? 3600000 : 15000);
            await store.finish(route,status,null,delay); route=null;
          }
          if (iterator) { await iterator.return().catch(()=>{}); iterator=null; }
          if (res.headersSent || controller.signal.aborted) throw new HttpError(controller.signal.aborted?504:502,'Upstream stream interrupted; retry the request','upstream_error');
          if (error instanceof HttpError) throw error;
          // 400/422 can reflect a provider-specific capability mismatch; keep
          // the configured fallback order, bounded by attempt and time budgets.
          if (attempt+1>=bounded(env.CLOUD_MAX_ATTEMPTS,3,1,3)) throw new HttpError(502,'All attempted upstream routes failed','upstream_error');
        }
      }
      throw new HttpError(502,'No successful upstream response','upstream_error');
    } catch (error) {
      const known=error instanceof HttpError;
      const status=known ? error.status : error instanceof z.ZodError ? 400 : 503;
      const message=known ? error.message : error instanceof z.ZodError ? 'Invalid request fields; see the API documentation' : 'Service temporarily unavailable';
      const type=known ? error.type : error instanceof z.ZodError ? 'invalid_request_error' : 'service_unavailable';
      // Log classifications only: never provider messages, credentials, prompt,
      // SQL parameters, connection strings or stack traces.
      if (!known && !(error instanceof z.ZodError)) console.error(JSON.stringify({ event:'gateway_failure', requestId, code: /^[A-Z_]{1,50}$/.test(error.code || '') ? error.code : 'internal_dependency_error' }));
      const data={ error:{ message, type, request_id:requestId } };
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) { res.write(`data: ${JSON.stringify(data)}\n\n`); res.end(); }
        else { if (error.retryAfter) res.setHeader('Retry-After',String(error.retryAfter)); send(res,status,data); }
      }
    } finally {
      clearTimeout(deadline); res.off('close',onDisconnect); req.off('aborted',onDisconnect);
      if (iterator) await iterator.return().catch(()=>{});
      if (route && store) await store.finish(route,499).catch(()=>{});
    }
  };
}
export default createHandler();
