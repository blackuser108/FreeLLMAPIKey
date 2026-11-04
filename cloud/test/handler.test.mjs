// These tests run REAL original provider transports against a LOCAL fake upstream.
// They are not evidence of inference against a real AI provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { createHandler } from '../dist-handler.mjs';
import { encrypt } from '../src/security.mjs';
import { OpenAICompatProvider } from '../dist-providers.mjs';

async function listen(handler){const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');return {server,url:`http://127.0.0.1:${server.address().port}`};}
const salt=randomBytes(16).toString('hex');
const env={DATABASE_URL:'test-only',CLOUD_SESSION_SECRET:'test-session-secret',CLOUD_ENCRYPTION_KEY:randomBytes(32).toString('hex'),CLOUD_ADMIN_PASSWORD_HASH:salt+':'+scryptSync('test-password',salt,64).toString('hex')};
const body={model:'auto',messages:[{role:'user',content:'Hello'}],max_tokens:32};
const header={Authorization:'Bearer test-cloud-access-key','Content-Type':'application/json'};
function fakeStore(routes){return {finished:[],reserves:0,limit:async()=>true,authenticate:async k=>k==='test-cloud-access-key'?'test-user':null,models:async()=>routes.length?['groq/test-model']:[],reserve:async function(){this.reserves++;return routes.shift()||null;},finish:async function(r,status){this.finished.push({id:r.id,status});},maintenance:async()=>{},providers:async()=>[],accessKeys:async()=>[],stats:async()=>({})};}
function route(id='1'){return {id,lease:id,platform:'groq',model:'test-model',secret:encrypt('test-upstream-secret',env.CLOUD_ENCRYPTION_KEY)};}

test('real FreeLLMAPI transport handles chat, streaming, authentication and pre-stream fallback',async t=>{
  let mode='ok';let calls=0;
  const upstream=await listen(async(req,res)=>{
    calls++;assert.equal(req.headers.authorization,'Bearer test-upstream-secret');
    let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);
    assert.equal(input.model,'test-model');assert.equal(input.max_tokens,32);
    if(mode==='fail-first'&&calls===1){res.writeHead(429,{'Content-Type':'application/json','Retry-After':'2'});return res.end('{"error":{"message":"test quota"}}');}
    if(mode==='secret-error'){res.writeHead(500,{'Content-Type':'application/json'});return res.end('{"error":{"message":"test-upstream-secret"}}');}
    if(mode==='slow'){const timer=setTimeout(()=>{if(!res.destroyed)res.end('{}');},5000);res.once('close',()=>clearTimeout(timer));return;}
    if(input.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:0,model:'test-model',choices:[{index:0,delta:{content:'Hello'},finish_reason:null}]})+'\n\n');if(mode==='mid-stream-error'){res.end('data: {"error":{"message":"test-upstream-secret"}}\n\n');return;}res.end('data: [DONE]\n\n');}
    else {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'test',object:'chat.completion',created:0,model:'test-model',choices:[{index:0,message:{role:'assistant',content:'Hello'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}}));}
  });
  const store=fakeStore([route()]);
  const gateway=await listen(createHandler({makeStore:()=>store,env,makeProvider:()=>new OpenAICompatProvider({platform:'groq',name:'Test',baseUrl:upstream.url,timeoutMs:5000})}));
  t.after(()=>{gateway.server.closeAllConnections();gateway.server.close();upstream.server.closeAllConnections();upstream.server.close();});
  const post=(data,headers=header)=>fetch(gateway.url+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(data)});
  await t.test('bad API key rejected without a provider request',async()=>{const r=await post(body,{...header,Authorization:'Bearer invalid-key'});assert.equal(r.status,401);assert.equal(calls,0);assert.equal(store.reserves,0);});
  await t.test('unknown upstream field rejected before provider selection',async()=>{const r=await post({...body,upstream:'http://localhost'});assert.equal(r.status,400);assert.equal(calls,0);});
  await t.test('real non-streaming adapter returns OpenAI response',async()=>{const r=await post(body);assert.equal(r.status,200);assert.equal((await r.json()).choices[0].message.content,'Hello');assert.equal(store.finished.at(-1).status,200);});
  await t.test('real SSE adapter outputs content and DONE',async()=>{store.reserve=async()=>route('2');const r=await post({...body,stream:true});assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/event-stream/);const text=await r.text();assert.match(text,/Hello/);assert.match(text,/\[DONE\]/);});
  await t.test('429 before first chunk falls back without mixing streams',async()=>{mode='fail-first';calls=0;let next=0;store.reserve=async()=>route(String(++next));const r=await post({...body,stream:true});assert.equal(r.status,200);assert.match(await r.text(),/Hello/);assert.equal(calls,2);assert.ok(store.finished.some(x=>x.status===429));});
  await t.test('upstream secret error never reaches client',async()=>{mode='secret-error';const r=await post(body);assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/test-upstream-secret/);});
  await t.test('mid-stream failure emits error, no DONE, no second provider',async()=>{mode='mid-stream-error';calls=0;const r=await post({...body,stream:true});const text=await r.text();assert.equal(calls,1);assert.match(text,/Hello/);assert.match(text,/"error"/);assert.doesNotMatch(text,/\[DONE\]|test-upstream-secret/);});
  await t.test('deadline aborts slow provider and releases reservation',async()=>{mode='slow';const short=await listen(createHandler({makeStore:()=>store,env:{...env,CLOUD_REQUEST_TIMEOUT_MS:'1000'},makeProvider:()=>new OpenAICompatProvider({platform:'groq',name:'Test',baseUrl:upstream.url})}));try{const r=await fetch(short.url+'/v1/chat/completions',{method:'POST',headers:header,body:JSON.stringify(body)});assert.equal(r.status,504);assert.ok(store.finished.some(x=>x.status===504));}finally{short.server.closeAllConnections();short.server.close();}});
  await t.test('admin requires signed cookie; same-origin login enforced',async()=>{let r=await fetch(gateway.url+'/api/state');assert.equal(r.status,401);r=await fetch(gateway.url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid'},body:'{"password":"test-password"}'});assert.equal(r.status,403);r=await fetch(gateway.url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:gateway.url.replace('http:','https:')},body:'{"password":"test-password"}'});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);r=await fetch(gateway.url+'/api/state',{headers:{Cookie:cookie.split(';')[0]}});assert.equal(r.status,200);});
});
