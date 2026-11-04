import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createHandler } from '../dist-handler.mjs';
import * as adapters from '../dist-providers.mjs';
import { decrypt, signSession } from '../src/security.mjs';

const env={DATABASE_URL:'test-only',CLOUD_SESSION_SECRET:'test-session-secret',CLOUD_ENCRYPTION_KEY:randomBytes(32).toString('hex'),CLOUD_ADMIN_PASSWORD_HASH:'configured'};
async function listen(handler){const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');return {server,url:`http://127.0.0.1:${server.address().port}`};}
test('saving a provider without manual model IDs discovers models and stores only encrypted key',async t=>{
  let saved;let discoveryCalls=0;
  const store={limit:async()=>true,addProvider:async(p,secret)=>{saved={p,secret};return {id:'test-provider'};},recordCheck:async()=>{}};
  const gateway=await listen(createHandler({env,makeStore:()=>store,discoverModels:async(platform,key)=>{discoveryCalls++;assert.equal(platform,'groq');assert.equal(key,'test-upstream-key');return {models:[{id:'test-chat'}],source:'provider',message:'Fetched catalog',keyStatus:'catalog_checked'};}}));
  t.after(()=>{gateway.server.closeAllConnections();gateway.server.close();});
  const headers={'Content-Type':'application/json',Origin:gateway.url.replace('http:','https:'),Cookie:'__Host-freellmapi='+signSession(env.CLOUD_SESSION_SECRET)};
  const r=await fetch(gateway.url+'/api/providers',{method:'POST',headers,body:JSON.stringify({platform:'groq',label:'test',key:'test-upstream-key',free_confirmed:true})});
  assert.equal(r.status,201);assert.equal(discoveryCalls,1);assert.deepEqual(saved.p.models,['test-chat']);assert.equal(decrypt(saved.secret,env.CLOUD_ENCRYPTION_KEY),'test-upstream-key');assert.ok(!JSON.stringify(await r.json()).includes('test-upstream-key'));
});
test('authenticated discovery is read-only and does not mistake upstream rejection for admin logout',async t=>{
  let writes=0;
  const gateway=await listen(createHandler({env,makeStore:()=>({limit:async()=>true,addProvider:async()=>{writes++;}}),discoverModels:async()=>{const e=new Error('test-upstream-key must not escape');e.status=401;throw e;}}));
  t.after(()=>{gateway.server.closeAllConnections();gateway.server.close();});
  const headers={'Content-Type':'application/json',Origin:gateway.url.replace('http:','https:'),Cookie:'__Host-freellmapi='+signSession(env.CLOUD_SESSION_SECRET)};
  const r=await fetch(gateway.url+'/api/providers/discover',{method:'POST',headers,body:JSON.stringify({platform:'groq',key:'test-upstream-key',free_confirmed:true})});
  assert.equal(r.status,422);const body=await r.json();assert.equal(body.error.type,'provider_auth_error');assert.doesNotMatch(JSON.stringify(body),/test-upstream-key/);assert.equal(writes,0);
});
test('admin playground tests a real adapter path without asking for a separate cloud API key',async t=>{
  let calls=0;
  const secret=(await import('../src/security.mjs')).encrypt('test-upstream-key',env.CLOUD_ENCRYPTION_KEY);
  const store={limit:async()=>true,maintenance:async()=>{},reserve:async()=>({id:'test-route',lease:'test-lease',platform:'groq',model:'test-chat',secret}),finish:async()=>{},models:async()=>['groq/test-chat']};
  const gateway=await listen(createHandler({env,makeStore:()=>store,makeProvider:()=>({chatCompletion:async()=>{calls++;return {object:'chat.completion',choices:[{message:{role:'assistant',content:'OK'}}]};},async *streamChatCompletion(){calls++;yield {choices:[{delta:{content:'OK'}}]};}})}));
  t.after(()=>{gateway.server.closeAllConnections();gateway.server.close();});
  const headers={'Content-Type':'application/json',Origin:gateway.url.replace('http:','https:'),Cookie:'__Host-freellmapi='+signSession(env.CLOUD_SESSION_SECRET)};
  const r=await fetch(gateway.url+'/api/playground',{method:'POST',headers,body:JSON.stringify({model:'groq/test-chat',messages:[{role:'user',content:'test'}],max_tokens:16})});
  assert.equal(r.status,200);assert.equal(calls,1);assert.equal((await r.json()).choices[0].message.content,'OK');
  const stream=await fetch(gateway.url+'/api/playground',{method:'POST',headers,body:JSON.stringify({model:'groq/test-chat',messages:[{role:'user',content:'test'}],max_tokens:16,stream:true})});
  assert.equal(stream.status,200);assert.match(await stream.text(),/data: \[DONE\]/);assert.equal(calls,2);
  const noOrigin=await fetch(gateway.url+'/api/playground',{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:'{}'});assert.equal(noOrigin.status,403);
  const noCookie=await fetch(gateway.url+'/api/playground',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(noCookie.status,401);assert.equal(calls,2);
});

test('refreshing saved provider models decrypts only on server and preserves manually configured IDs',async t=>{
  const {encrypt}=await import('../src/security.mjs');let updated;let checked;
  const id='11111111-1111-4111-8111-111111111111';
  const store={limit:async()=>true,provider:async()=>({platform:'groq',models:['manual-chat'],secret:encrypt('test-upstream-key',env.CLOUD_ENCRYPTION_KEY)}),updateModels:async(_id,models)=>{updated=models;},recordCheck:async(_id,status)=>{checked=status;}};
  const gateway=await listen(createHandler({env,makeStore:()=>store,discoverModels:async(platform,key)=>{assert.equal(key,'test-upstream-key');assert.equal(platform,'groq');return {models:[{id:'discovered-chat'}],keyStatus:'catalog_checked',message:'Fetched catalog'};}}));
  t.after(()=>{gateway.server.closeAllConnections();gateway.server.close();});
  const headers={'Content-Type':'application/json',Origin:gateway.url.replace('http:','https:'),Cookie:'__Host-freellmapi='+signSession(env.CLOUD_SESSION_SECRET)};
  const res=await fetch(gateway.url+'/api/providers/refresh',{method:'POST',headers,body:JSON.stringify({id})});assert.equal(res.status,200);
  assert.deepEqual(updated,['manual-chat','discovered-chat']);assert.equal(checked,'catalog_checked');assert.doesNotMatch(JSON.stringify(await res.json()),/test-upstream-key|secret/);
});
test('original model-discovery parser is reused with free-model filtering',async t=>{
  assert.equal(typeof adapters.discoverCloudModels,'function');
  const upstream=await listen((req,res)=>{assert.equal(req.method,'GET');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[
    {id:'vendor/free-chat:free',pricing:{prompt:'0',completion:'0'}},
    {id:'vendor/paid-chat',pricing:{prompt:'0.01',completion:'0.01'}},
    {id:'vendor/free-embedding:free',type:'embedding',pricing:{prompt:'0',completion:'0'}},
  ]}));});
  t.after(()=>{upstream.server.closeAllConnections();upstream.server.close();});
  const provider=new adapters.OpenAICompatProvider({platform:'openrouter',name:'test',baseUrl:upstream.url});
  const result=await adapters.discoverCloudModels('openrouter','test-upstream-key',{provider});
  assert.deepEqual(result.models.map(x=>x.id),['vendor/free-chat:free']);assert.equal(result.source,'provider');
});

test('bundled suggestions preserve the original catalog for each supported provider',()=>{
  for(const platform of ['groq','google','nvidia','mistral','openrouter','cohere','cloudflare','zhipu','llmtr']){
    assert.ok(adapters.catalogFor(platform).length>0,platform+' should have original model suggestions');
  }
  // The signed free catalog currently disables Cerebras/HF. Never silently
  // reinstate retired or paid rows from an older bundled migration.
  assert.equal(adapters.catalogFor('cerebras').length,0);
  assert.equal(adapters.catalogFor('huggingface').length,0);
});
