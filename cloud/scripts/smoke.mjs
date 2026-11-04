// Independent HTTP client against the PUBLIC deployment. Prints statuses only;
// never keys, passwords, cookies, prompts, or generated AI content.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base=process.argv.find(x=>x.startsWith('https://'));
if(!base)throw new Error('Pass the public HTTPS deployment origin');
const origin=new URL(base).origin;
const access=await readFile(new URL('../../.cloud-private/ACCESS.txt',import.meta.url),'utf8');
const key=access.match(/^Cloud API key: (.+)$/m)?.[1];const password=access.match(/^Admin password: (.+)$/m)?.[1];
if(!key||!password)throw new Error('Generated private access file is incomplete');
const headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
const report={origin,checkedAt:new Date().toISOString(),checks:[],realInference:'not_run'};
async function check(name,path,expected,init={}){
  const res=await fetch(origin+path,{...init,signal:AbortSignal.timeout(process.argv.includes('--ai')?280000:30000)});
  assert.equal(res.status,expected,`${name}: unexpected HTTP status`);
  report.checks.push({name,status:res.status});console.log(name+': HTTP '+res.status);return res;
}
const site=await check('public website','/',200);assert.match(await site.text(),/FreeLLMAPI Cloud/);assert.match(site.headers.get('content-security-policy'),/frame-ancestors 'none'/);
await check('public liveness','/api/health',200);
await check('missing API key','/v1/models',401);
await check('incorrect API key','/v1/models',401,{headers:{Authorization:'Bearer invalid-test-key'}});
await check('admin requires login','/api/state',401);
await check('catalog requires login','/api/catalog?platform=groq',401);
await check('playground requires login','/api/playground',401,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
const login=await check('real admin login','/api/login',200,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({password})});
const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);
const state=await (await check('authenticated PostgreSQL readiness','/api/state',200,{headers:{Cookie:cookie.split(';')[0]}})).json();assert.equal(state.database,'connected');
const adminHeaders={'Content-Type':'application/json',Origin:origin,Cookie:cookie.split(';')[0]};
const catalog=await (await check('authenticated original model catalog','/api/catalog?platform=groq',200,{headers:adminHeaders})).json();assert.ok(catalog.models.length>0);assert.equal(catalog.catalog.verified,true);report.catalogVersion=catalog.catalog.version;
await check('model discovery blocks cross-origin','/api/providers/discover',403,{method:'POST',headers:{...adminHeaders,Origin:'https://untrusted.invalid'},body:'{}'});
if(process.argv.includes('--discovery')){
  const invalidKey='invalid-discovery-test-key';
  const rejected=await (await check('real provider metadata rejects invalid key safely','/api/providers/discover',422,{method:'POST',headers:adminHeaders,body:JSON.stringify({platform:'groq',key:invalidKey,free_confirmed:true})})).json();
  assert.equal(rejected.error.type,'provider_auth_error');assert.ok(!JSON.stringify(rejected).includes(invalidKey));
  await check('admin session survives upstream rejection','/api/state',200,{headers:adminHeaders});
  const llmtr=await (await check('LLMTr catalog clearly leaves key unchecked','/api/providers/discover',200,{method:'POST',headers:adminHeaders,body:JSON.stringify({platform:'llmtr',key:invalidKey,free_confirmed:true})})).json();
  assert.equal(llmtr.keyStatus,'unchecked');assert.ok(llmtr.models.length>0);
}
for(const provider of state.providers)for(const name of ['secret','encrypted_key','iv','authTag','key'])assert.equal(Object.hasOwn(provider,name),false,'Management response contains a credential field');
await check('admin cross-origin write blocked','/api/keys',403,{method:'POST',headers:{Cookie:cookie.split(';')[0],Origin:'https://untrusted.invalid','Content-Type':'application/json'},body:'{"label":"must-not-create"}'});
const models=await (await check('authenticated model list','/v1/models',200,{headers})).json();assert.equal(models.object,'list');report.configuredModels=models.data.length;
await check('arbitrary upstream rejected','/v1/chat/completions',400,{method:'POST',headers,body:JSON.stringify({model:'auto',messages:[{role:'user',content:'test'}],upstream:'http://169.254.169.254'})});
if(!state.providers.some(p=>p.enabled)){
  for(const stream of [false,true])await check(stream?'unconfigured stream fails clearly':'unconfigured chat fails clearly','/v1/chat/completions',503,{method:'POST',headers,body:JSON.stringify({model:'auto',messages:[{role:'user',content:'test'}],stream,max_tokens:1})});
  await check('admin playground clearly reports no configured provider','/api/playground',503,{method:'POST',headers:adminHeaders,body:JSON.stringify({model:'auto',messages:[{role:'user',content:'test'}],max_tokens:1})});
}else if(process.argv.includes('--ai')){
  if(process.env.CLOUD_ALLOW_FREE_TEST!=='1')throw new Error('Set CLOUD_ALLOW_FREE_TEST=1 only after explicit free-tier authorization.');
  const model=process.env.CLOUD_TEST_MODEL||'auto';
  const request={model,messages:[{role:'user',content:'Reply with the single word OK.'}],max_tokens:32};
  const chat=await (await check('real provider chat','/v1/chat/completions',200,{method:'POST',headers,body:JSON.stringify(request)})).json();
  assert.ok(chat.choices?.[0]?.message);report.realChatModel=chat.model;
  const stream=await check('real provider streaming','/v1/chat/completions',200,{method:'POST',headers,body:JSON.stringify({...request,stream:true})});assert.match(stream.headers.get('content-type'),/text\/event-stream/);
  const reader=stream.body.getReader();const decoder=new TextDecoder();let buffer='';let chunks=0;let done=false;
  while(true){const read=await reader.read();if(read.done)break;buffer+=decoder.decode(read.value,{stream:true});const events=buffer.split('\n\n');buffer=events.pop();for(const event of events){const line=event.split('\n').find(x=>x.startsWith('data: '));if(!line)continue;const data=line.slice(6);if(data==='[DONE]'){done=true;continue;}const item=JSON.parse(data);assert.ok(!item.error,'Provider stream failed');if(item.choices?.length)chunks++;}}
  assert.ok(chunks>0);assert.ok(done);report.realInference='passed';report.streamingChunks=chunks;
}
await mkdir(new URL('../evidence/',import.meta.url),{recursive:true});
await writeFile(new URL('../evidence/latest.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
