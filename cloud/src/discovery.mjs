import catalog from '../catalog.json' with { type:'json' };
import { parseModelCatalog, readCappedBody, hasModelList } from '../../server/src/services/model-discovery.ts';
import { providerFor } from './providers.mjs';

export function catalogFor(platform) {
  return (catalog[platform]||[]).filter(m=>!/(prompt-guard|safeguard|moderation)/i.test(m.id)).slice(0,100);
}
function failure(status){const error=new Error('Provider catalog request failed');error.status=status;return error;}
async function readResponse(response){
  const text=await readCappedBody(response);
  if(!response.ok)throw failure(response.status);
  try{return JSON.parse(text);}catch{throw failure(502);}
}
async function get(url,key,signal,header='Authorization'){
  return fetch(url,{headers:{[header]:header==='Authorization'?'Bearer '+key:key},redirect:'error',signal});
}
export async function discoverCloudModels(platform,key,{provider,signal:clientSignal}={}){
  const known=catalogFor(platform);
  // LLMTr explicitly refuses automatic key checks. Keep the upstream catalog
  // policy instead of sending hidden chat probes or treating the public list
  // of paid/BYOK models as free. An explicit playground call can test the key.
  if(platform==='llmtr')return {models:known,source:'bundled',keyStatus:'unchecked',message:'LLMTr không hỗ trợ kiểm tra khóa tự động. Đã lấy catalogue miễn phí có chữ ký; dùng Thử chat để kiểm chứng.'};
  const signal=clientSignal?AbortSignal.any([clientSignal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000);
  const adapter=provider||providerFor(platform);
  let payload;
  try{
    if(platform==='google'){
      payload=await readResponse(await get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',key,signal,'x-goog-api-key'));
      payload={models:(payload.models||[]).filter(m=>m.supportedGenerationMethods?.includes('generateContent')).map(m=>({...m,id:m.name?.replace(/^models\//,'')}))};
    }else if(platform==='cloudflare'){
      const colon=key.indexOf(':');const account=key.slice(0,colon);const token=key.slice(colon+1);
      if(colon<1||!/^[a-f0-9]{32}$/i.test(account)||!token)throw failure(401);
      const data=await readResponse(await get(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?per_page=100`,token,signal));
      payload={data:(data.result||[]).filter(m=>!m.task?.name||/text generation/i.test(m.task.name)).map(m=>({...m,id:m.name}))};
    }else if(platform==='cohere'){
      payload=await readResponse(await get('https://api.cohere.ai/compatibility/v1/models',key,signal));
    }else{
      if(platform==='zhipu'&&!provider){const result=await adapter.validateKey(key);if(result===false||result?.valid===false)throw failure(401);}
      if(platform==='openrouter'&&!provider)await readResponse(await get('https://openrouter.ai/api/v1/key',key,signal));
      const response=await adapter.fetchModelCatalog(key);
      payload=await readResponse(response);
    }
  }catch(error){
    if([404,405].includes(error.status)&&known.length)return {models:known,source:'bundled',keyStatus:'unchecked',message:'Nhà cung cấp không có API liệt kê model phù hợp. Đã dùng catalogue gốc của FreeLLMAPI; khóa chưa được thử chat.'};
    throw error;
  }
  if(!hasModelList(payload))throw failure(502);
  const knownIds=new Set(known.map(m=>m.id));
  const all=parseModelCatalog(payload);
  const models=all.filter(m=>!m.kind&&m.id.length<=200&&!/(prompt-guard|safeguard|moderation)/i.test(m.id))
    .filter(m=>m.isFree!==false)
    .filter(m=>platform==='openrouter'?m.id.endsWith(':free'):(knownIds.has(m.id)||m.isFree===true))
    .slice(0,100).map(m=>({id:m.id,name:known.find(k=>k.id===m.id)?.name||m.id}));
  return {models,source:'provider',keyStatus:'catalog_checked',message:models.length?
    `Đã lấy ${models.length} model phù hợp. Chưa gửi yêu cầu sinh nội dung; dùng Thử chat để kiểm chứng.`:
    'Đã đọc danh sách từ nhà cung cấp nhưng chưa tìm được model chat phù hợp trong catalogue miễn phí. Có thể nhập ID thủ công sau khi kiểm tra gói của bạn.'};
}
