// Build-time only. Reconstruct the public upstream catalog in an EPHEMERAL DB.
// Never opens the user's local profile, imports credentials, or calls a provider.
import { readFileSync, writeFileSync } from 'node:fs';
import { verify } from 'node:crypto';
import { nodeSqliteFactory } from '../../server/src/db/node-sqlite.ts';
import { runMigrationsSync } from '../../server/src/db/migrate/runner.ts';
const db=nodeSqliteFactory(':memory:');
const previous=console.log;console.log=()=>{};
try{runMigrationsSync(db,'up');}finally{console.log=previous;}
const platforms=['groq','cerebras','google','nvidia','mistral','openrouter','huggingface','cohere','cloudflare','zhipu','llmtr'];
const catalog=Object.fromEntries(platforms.map(p=>[p,db.prepare(`select model_id as id, display_name as name, rpm_limit as rpm, rpd_limit as rpd, tpm_limit as tpm, tpd_limit as tpd
  from models where platform=? and enabled=1 order by intelligence_rank,model_id`).all(p).filter(m=>p!=='openrouter'||m.id.endsWith(':free'))]));
// paid_* columns are PAID-EQUIVALENT analytics prices, not a free-tier flag.
let info={source:'bundled-migrations',version:'0.16.11',verified:false};
if(process.argv.includes('--sync')){
  // Same public monthly endpoint and pinned signature as the desktop app.
  // No license, user data, provider credential or inference request is sent.
  const source=readFileSync(new URL('../../server/src/services/catalog-sync.ts',import.meta.url),'utf8');
  const publicKey=source.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/)[0];
  const response=await fetch('https://api.freellmapi.co/v1/latest',{redirect:'error',signal:AbortSignal.timeout(20000)});
  const bytes=Buffer.from(await response.arrayBuffer());
  if(!response.ok||bytes.length>4*1024*1024||!verify(null,bytes,publicKey,Buffer.from(response.headers.get('x-catalog-signature')||'','base64')))throw new Error('Catalog signature or response is invalid; existing snapshot preserved');
  const signed=JSON.parse(bytes);
  if(signed.tier!=='monthly'||typeof signed.version!=='string'||signed.version<'2026.06.07'||!Array.isArray(signed.models))throw new Error('Unexpected public monthly catalog');
  for(const platform of platforms)catalog[platform]=signed.models.filter(m=>m.platform===platform&&m.enabled&&(!m.modality||m.modality==='chat')&&typeof m.modelId==='string'&&m.modelId.length<=200)
    .filter(m=>platform!=='openrouter'||m.modelId.endsWith(':free'))
    .sort((a,b)=>a.intelligenceRank-b.intelligenceRank)
    .map(m=>({id:m.modelId,name:m.displayName||m.modelId}));
  info={source:'signed-monthly',version:signed.version,verified:true,url:'https://api.freellmapi.co/v1/latest',fetchedAt:new Date().toISOString()};
}
writeFileSync(new URL('../catalog.json',import.meta.url),JSON.stringify(catalog,null,2)+'\n');
writeFileSync(new URL('../catalog-info.json',import.meta.url),JSON.stringify(info,null,2)+'\n');
db.close();console.log('Generated public FreeLLMAPI catalog for '+platforms.length+' cloud providers.');
