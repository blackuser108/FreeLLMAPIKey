// One-way migration: local SQLite is OPENED READ-ONLY. Secrets stay in process
// memory, are decrypted using the local key, and re-encrypted for this cloud.
// Does NOT copy the local unified access key, admin sessions, cookies or prompts.
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { database } from '../src/store.mjs';
import { encrypt, decrypt } from '../src/security.mjs';
const supported=new Set(['groq','cerebras','google','nvidia','mistral','openrouter','huggingface','cohere','cloudflare','zhipu','llmtr']);
const apply=process.argv.includes('--apply');
if(apply&&!process.argv.includes('--confirm-free'))throw new Error('Confirm the source credentials are free-tier using --confirm-free before migrating.');
const dir=process.env.LOCAL_FREELLMAPI_DIR || (process.env.APPDATA ? path.join(process.env.APPDATA,'FreeLLMAPI') : '');
if(!dir)throw new Error('Set LOCAL_FREELLMAPI_DIR to your own local profile directory.');
const local=new DatabaseSync(path.join(dir,'freeapi.db'),{readOnly:true});
const rows=local.prepare('select * from api_keys').all();
const report={mode:apply?'applied':'dry-run',imported:[],skipped:[],unchanged:[],notes:['Local API access key and admin account are not migrated.','All quotas start fresh in cloud; shared upstream accounts still have combined provider-side usage.']};
const sql=apply?database():null;
const localKey=apply?(await readFile(path.join(dir,'.encryption-key'),'utf8')).trim():null;
try{
  for(const row of rows){
    if(!supported.has(row.platform)){report.skipped.push({platform:row.platform,reason:row.platform==='custom'?'Custom upstream requires a separate allowlist review':'Search-only or not yet included in cloud chat'});continue;}
    if(row.model_scope_json || row.proxy_encrypted || row.base_url || row.monthly_request_cap || row.monthly_token_cap){report.skipped.push({platform:row.platform,reason:'Key has per-key restrictions or proxy settings; manual review required to preserve them'});continue;}
    let models=local.prepare('select model_id,rpm_limit,rpd_limit,tpm_limit,tpd_limit from models where platform=? and enabled=1 and coalesce(paid_input_per_m,0)=0 and coalesce(paid_output_per_m,0)=0 and (key_id is null or key_id=?)').all(row.platform,row.id);
    if(row.platform==='openrouter')models=models.filter(m=>m.model_id.endsWith(':free'));
    models=models.filter(m=>!/prompt-guard|safeguard/.test(m.model_id));
    if(!models.length){report.skipped.push({platform:row.platform,reason:'No eligible free chat models in local catalog'});continue;}
    if(models.length>100){report.skipped.push({platform:row.platform,reason:'More than 100 models; choose a smaller explicit list'});continue;}
    const safeMinimum=(field,fallback)=>Math.min(fallback,...models.map(m=>m[field]).filter(n=>Number.isInteger(n)&&n>0));
    const metadata={platform:row.platform,models:models.length,enabled:!!row.enabled&&row.status==='healthy'};
    if(!apply){report.imported.push(metadata);continue;}
    const hex=createHash('sha256').update(`freellmapi-local:${row.platform}:${row.id}`).digest('hex').slice(0,32);
    const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    const secret=encrypt(decrypt({encrypted:row.encrypted_key,iv:row.iv,authTag:row.auth_tag},localKey),process.env.CLOUD_ENCRYPTION_KEY);
    const inserted=await sql`insert into freellmapi.providers(id,platform,label,secret,models,enabled,free_confirmed,priority,rpm,rpd,tpm,tpd,concurrency)
      values(${id},${row.platform},${('Local import '+row.platform+' #'+row.id).slice(0,80)},${sql.json(secret)},${models.map(m=>m.model_id)},${metadata.enabled},true,
      ${row.platform==='groq'?10:row.platform==='google'?20:100},${safeMinimum('rpm_limit',10)},${safeMinimum('rpd_limit',100)},${safeMinimum('tpm_limit',10000)},${safeMinimum('tpd_limit',100000)},1)
      on conflict(id) do nothing returning id`;
    (inserted.length?report.imported:report.unchanged).push(metadata);
  }
}finally{local.close();if(sql)await sql.end();}
await writeFile(new URL('../../.cloud-private/migration-report.json',import.meta.url),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report,null,2));
