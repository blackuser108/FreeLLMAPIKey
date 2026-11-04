// Real, isolated PostgreSQL tests. Only rows bearing this run's UUID are removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, databaseTls, createDatabase } from '../src/store.mjs';
const a=createDatabase(process.env.DATABASE_URL,databaseTls);const b=createDatabase(process.env.DATABASE_URL,databaseTls);
const one=new Store(a),two=new Store(b);const id=randomUUID();const model='test-'+id;const bucket='test-'+id;
test('real PostgreSQL serializes quotas, shared cooldown, leases and auth',async t=>{
  t.after(async()=>{await a`delete from freellmapi.providers where id=${id}`;await a`delete from freellmapi.rate_buckets where id=${bucket}`;await Promise.all([a.end(),b.end()]);});
  await a`insert into freellmapi.providers(id,platform,label,secret,models,free_confirmed,rpm,rpd,tpm,tpd,concurrency)
    values(${id},'groq',${model},${a.json({test:true})},${[model]},true,2,3,1000,2000,1)`;
  assert.equal(await one.authenticate('invalid-key-xxxxxxxxxxxx'),null);
  const [providers,keys,stats]=await Promise.all([one.providers(),one.accessKeys(),one.stats()]);
  assert.ok(Array.isArray(providers));assert.ok(Array.isArray(keys));assert.equal(typeof stats.attempts,'number');
  await one.recordCheck(id,'catalog_checked','Danh sách đã được đọc; chưa thử chat.');
  await one.updateModels(id,[model,'extra-'+model]);
  const provider=await two.provider(id);assert.ok(provider.models.includes('extra-'+model));
  const listed=(await two.providers()).find(p=>p.id===id);
  assert.equal(listed.health_status,'catalog_checked');assert.ok(listed.checked_at);assert.equal(Object.hasOwn(listed,'secret'),false);
  const attempts=await Promise.all(Array.from({length:12},(_,i)=>(i%2?one:two).limit(bucket,3)));
  assert.equal(attempts.filter(Boolean).length,3,'atomic rate counter allows exactly the shared budget');
  const leases=await Promise.all([one.reserve(model,100),two.reserve(model,100)]);
  assert.equal(leases.filter(Boolean).length,1,'only one process reserves concurrency=1');
  const lease=leases.find(Boolean);await one.finish(lease,429,null,60000);
  assert.equal(await two.reserve(model,100),null,'cooldown from process one blocks process two');
  await a`update freellmapi.providers set cooldown_until=now()-interval '1 second' where id=${id}`;
  const next=await two.reserve(model,100);assert.ok(next);assert.equal(await one.reserve(model,100),null);
  await two.finish(next,200,25);
  assert.equal(await one.reserve(model,100),null,'both failed and successful attempts consume RPM');
  await a`update freellmapi.attempts set created_at=now()-interval '2 minutes' where provider_id=${id}`;
  const third=await one.reserve(model,100);assert.ok(third);
  await a`update freellmapi.attempts set expires_at=now()-interval '1 second' where id=${third.lease}`;
  assert.equal(await two.reserve(model,100),null,'daily cap stays enforced when a lease expires');
  const [row]=await a`select count(*)::int as n from freellmapi.attempts where provider_id=${id}`;assert.equal(row.n,3);
  await assert.rejects(a`select * from public.nonexistent_table_for_cloud_test`);
});
