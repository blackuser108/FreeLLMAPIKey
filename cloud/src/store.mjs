import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { digest } from './security.mjs';
let sql;
// Public trust anchor downloaded from the official Supabase dashboard. Verify
// both CA chain AND hostname; do not use ssl:'require' (it disables verification).
export const databaseTls = { rejectUnauthorized: true, ca: typeof __SUPABASE_CA__ !== 'undefined' ? __SUPABASE_CA__ : readFileSync(new URL('../supabase-ca.pem',import.meta.url),'utf8') };
export function database() {
  if (!process.env.DATABASE_URL) throw new Error('Database not configured');
  // Supavisor transaction mode: no prepared statements, 1 connection per instance.
  // https://supabase.com/docs/guides/database/connecting-to-postgres
  return sql ||= postgres(process.env.DATABASE_URL, { ssl: databaseTls, max: 1, max_pipeline: 1, prepare: false, idle_timeout: 5, max_lifetime: 60, connect_timeout: 8, connection: { statement_timeout: 8000, application_name:'freellmapi-cloud' }, onnotice: () => {} });
}
export class Store {
  constructor(db = database()) {
    this.db = db;
    // Supavisor transaction pooling does not support query pipelining. Also
    // bound the WHOLE operation (including waiting for a connection), rather
    // than relying only on connect_timeout / server-side statement_timeout.
    // https://supabase.com/docs/guides/database/postgres-js
    return new Proxy(this,{get(target,name,receiver){
      const value=Reflect.get(target,name,receiver);
      if(typeof value!=='function'||name==='constructor')return value;
      return (...args)=>{
        let timer;
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{
          const error=new Error('Database operation deadline');error.code='DB_DEADLINE';reject(error);
          if(sql===db)sql=null;
          db.end({timeout:0}).catch(()=>{});
        },12000);});
        return Promise.race([Promise.resolve().then(()=>value.apply(target,args)),timeout]).finally(()=>clearTimeout(timer));
      };
    }});
  }
  async ping() { await this.db`select 1`; }
  async authenticate(key) {
    if (typeof key !== 'string' || key.length < 20 || key.length > 200) return null;
    const [row] = await this.db`select id from freellmapi.access_keys where digest=${digest(key)} and enabled=true`;
    return row?.id || null;
  }
  async limit(id, max, windowSeconds = 60) {
    const [row] = await this.db`
      insert into freellmapi.rate_buckets(id,window_start,count) values(${id},now(),1)
      on conflict(id) do update set
        count=case when freellmapi.rate_buckets.window_start <= now()-make_interval(secs=>${windowSeconds}) then 1 else freellmapi.rate_buckets.count+1 end,
        window_start=case when freellmapi.rate_buckets.window_start <= now()-make_interval(secs=>${windowSeconds}) then now() else freellmapi.rate_buckets.window_start end
      returning count`;
    return row.count <= max;
  }
  async models() {
    const rows = await this.db`select platform,models from freellmapi.providers where enabled and free_confirmed order by priority,created_at`;
    const ids = new Set(); for (const r of rows) for (const m of r.models) ids.add(`${r.platform}/${m}`);
    return [...ids];
  }
  async reserve(model, reserved, excluded = [], ttlSeconds = 275) {
    return this.db.begin(async tx => {
      // Row locks serialize decisions across ALL Vercel instances; skipped locked
      // rows return a short 429 instead of opening another route over its cap.
      const rows = await tx`select * from freellmapi.providers
        where enabled and free_confirmed and cooldown_until <= now()
          and not (id = any(${excluded}::uuid[]))
        order by priority, last_used_at, id for update skip locked`;
      for (const p of rows) {
        const target = p.models.find(m => model === 'auto' || model === m || model === `${p.platform}/${m}`);
        if (!target) continue;
        const [usage] = await tx`select
          count(*) filter(where created_at > now()-interval '1 minute')::int as rpm,
          count(*)::int as rpd,
          coalesce(sum(coalesce(used_tokens,reserved_tokens)) filter(where created_at > now()-interval '1 minute'),0)::bigint as tpm,
          coalesce(sum(coalesce(used_tokens,reserved_tokens)),0)::bigint as tpd,
          count(*) filter(where finished_at is null and expires_at > now())::int as active
          from freellmapi.attempts where provider_id=${p.id} and created_at > now()-interval '24 hours'`;
        if (usage.rpm >= p.rpm || usage.rpd >= p.rpd || Number(usage.tpm)+reserved > p.tpm || Number(usage.tpd)+reserved > p.tpd || usage.active >= p.concurrency) continue;
        const lease = randomUUID();
        await tx`insert into freellmapi.attempts(id,provider_id,model,reserved_tokens,expires_at)
          values(${lease},${p.id},${target},${reserved},now()+make_interval(secs=>${ttlSeconds}))`;
        await tx`update freellmapi.providers set last_used_at=now() where id=${p.id}`;
        return { ...p, model: target, lease };
      }
      return null;
    });
  }
  async finish(route, status, tokens = null, cooldownMs = 0) {
    await this.db.begin(async tx => {
      await tx`update freellmapi.attempts set finished_at=now(),status=${status},used_tokens=${Number.isInteger(tokens) && tokens >= 0 ? tokens : null} where id=${route.lease} and finished_at is null`;
      await tx`update freellmapi.providers set last_status=${status}, cooldown_until=greatest(cooldown_until,now()+make_interval(secs=>${Math.max(0,Math.min(cooldownMs,86400000))/1000})) where id=${route.id}`;
    });
  }
  async maintenance() {
    await this.db.begin(async tx => {
      const rows = await tx`update freellmapi.maintenance set last_run=now() where id=true and last_run < now()-interval '1 hour' returning id`;
      if (!rows.length) return;
      // Request-driven TTL cleanup. Quotas use DB time and ignore expired leases
      // even if cleanup has not run; no periodic AI requests or paid scheduler.
      await tx`delete from freellmapi.attempts where created_at < now()-interval '25 hours'`;
      await tx`delete from freellmapi.rate_buckets where window_start < now()-interval '25 hours'`;
    });
  }
  async providers() {
    return this.db`select id,platform,label,models,enabled,free_confirmed,priority,rpm,rpd,tpm,tpd,concurrency,last_status,
      case when cooldown_until > now() then cooldown_until else null end as cooldown_until
      from freellmapi.providers order by priority,created_at`;
  }
  async addProvider(p, secret) {
    const [row] = await this.db`insert into freellmapi.providers(platform,label,secret,models,free_confirmed,priority,rpm,rpd,tpm,tpd,concurrency)
      values(${p.platform},${p.label},${this.db.json(secret)},${p.models},true,${p.priority},${p.rpm},${p.rpd},${p.tpm},${p.tpd},${p.concurrency}) returning id`;
    return row;
  }
  async toggleProvider(id, enabled) { await this.db`update freellmapi.providers set enabled=${enabled} where id=${id}`; }
  async accessKeys() { return this.db`select id,label,enabled,created_at from freellmapi.access_keys order by created_at desc`; }
  async addAccessKey(label, key) {
    const [row] = await this.db`insert into freellmapi.access_keys(label,digest) values(${label},${digest(key)}) returning id`;
    return row;
  }
  async revokeAccessKey(id) { await this.db`update freellmapi.access_keys set enabled=false where id=${id}`; }
  async stats() {
    const [row] = await this.db`select count(*)::int as attempts, count(*) filter(where status=200)::int as succeeded,
      count(*) filter(where status is not null and status<>200)::int as failed,
      count(*) filter(where finished_at is null and expires_at>now())::int as active,
      coalesce(sum(coalesce(used_tokens,reserved_tokens)),0)::bigint as accounted_tokens
      from freellmapi.attempts where created_at>now()-interval '24 hours'`;
    return row;
  }
}
