'use strict';
const el=id=>document.getElementById(id);
const base=location.origin+'/v1';
el('base-url').textContent=base;
el('curl-example').textContent=`curl "${base}/chat/completions" \\\n  -H "Authorization: Bearer $FREELLMAPI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}],"stream":true}'`;
function notice(message,error=false){el('notice').hidden=false;el('notice').className=error?'error':'';el('notice').textContent=message;}
async function api(path,body){
  const res=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>({}));
  if(!res.ok){if(res.status===401&&data.error?.type==='authentication_error'){el('dashboard').hidden=true;el('login-panel').hidden=false;}throw new Error(data.error?.message||'Không thể kết nối dịch vụ.');}
  return data;
}
async function task(form,fn){const buttons=[...form.querySelectorAll('button')].filter(b=>!b.disabled&&b.id!=='stop');buttons.forEach(b=>b.disabled=true);try{await fn();}catch(e){notice(e.message,true);}finally{buttons.forEach(b=>b.disabled=false);}}
function row(title,detail,...actions){const li=document.createElement('li');const text=document.createElement('div');const strong=document.createElement('strong');strong.textContent=title;const small=document.createElement('small');small.textContent=detail;text.append(strong,small);li.append(text);const controls=document.createElement('div');controls.className='row-actions';for(const action of actions.filter(Boolean)){const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=action.label;button.onclick=()=>task(li,action.run);controls.append(button);}li.append(controls);return li;}
let catalogPlatform;
async function loadCatalog(){
  const platform=el('platform').value;catalogPlatform=platform;
  el('models').value='';el('model-suggestions').replaceChildren();el('catalog-status').textContent='Đang tải catalogue…';el('discovery-status').textContent='Chỉ đọc danh sách, không gửi yêu cầu sinh nội dung.';
  el('key-help').textContent=platform==='cloudflare'?'Định dạng: ACCOUNT_ID:API_TOKEN. Token cần quyền Workers AI của tài khoản.':'Nhập API key của '+el('platform').selectedOptions[0].textContent+'.';
  try{const data=await api('/api/catalog?platform='+encodeURIComponent(platform));if(platform!==el('platform').value)return;
    el('catalog-status').textContent=data.message;
    const buttons=data.models.map(m=>{const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=m.name||m.id;b.title=m.id;b.onclick=()=>{const ids=el('models').value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);if(!ids.includes(m.id))ids.push(m.id);el('models').value=ids.join('\n');};return b;});el('model-suggestions').replaceChildren(...buttons);
  }catch(e){el('catalog-status').textContent=e.message;}
}
async function refresh(){
  const selectedModel=el('test-model').value;
  const state=await api('/api/state');el('dashboard').hidden=false;el('login-panel').hidden=true;el('connection').textContent='Cloud + PostgreSQL đã kết nối';
  const stats=[['Lượt thử / 24h',state.stats.attempts],['AI thành công / 24h',state.stats.succeeded],['Đang xử lý',state.stats.active],['Lượt lỗi / 24h',state.stats.failed]];
  el('stats').replaceChildren(...stats.map(([label,value])=>{const div=document.createElement('div');const strong=document.createElement('strong');strong.textContent=value;const span=document.createElement('span');span.textContent=label;div.append(strong,span);return div;}));
  el('keys').replaceChildren(...state.keys.map(k=>row(k.label,k.enabled?'Đang hoạt động':'Đã thu hồi',k.enabled?{label:'Thu hồi',run:async()=>{await api('/api/keys/revoke',{id:k.id});await refresh();notice('Đã thu hồi khóa.');}}:null)));
  el('providers').replaceChildren(...state.providers.map(p=>row(p.label+' · '+p.platform,`${p.enabled?'Bật':'Tắt'} · ${p.models.length} model: ${p.models.join(', ')} · ${p.check_message||'Khóa chưa được kiểm tra qua danh sách model.'}${p.checked_at?' ('+new Date(p.checked_at).toLocaleString()+')':''} · ${p.rpm} lượt/phút · ${p.concurrency} đồng thời${p.cooldown_until?' · Đang cooldown đến '+new Date(p.cooldown_until).toLocaleString():''}${p.last_status?' · HTTP gọi AI gần nhất: '+p.last_status:''}`,
    {label:'Lấy lại model',run:async()=>{notice('Đang đọc danh sách từ nhà cung cấp…');const result=await api('/api/providers/refresh',{id:p.id});await refresh();notice(result.message);}},
    {label:'Chọn để thử',run:async()=>{el('test-model').value=p.platform+'/'+p.models[0];el('playground-panel').scrollIntoView({behavior:'smooth'});el('prompt').focus();notice('Đã chọn model. Bấm Gửi yêu cầu AI thật để kiểm chứng.');}},
    {label:p.enabled?'Tạm tắt':'Bật lại',run:async()=>{await api('/api/providers/toggle',{id:p.id,enabled:!p.enabled});await refresh();}})));
  if(!state.providers.length)el('providers').append(row('Chưa có nhà cung cấp','Thêm khóa miễn phí và model trước khi gọi AI.'));
  const ids=state.providers.filter(p=>p.enabled).flatMap(p=>p.models.map(m=>p.platform+'/'+m));
  el('test-model').replaceChildren(...['auto',...new Set(ids)].map(id=>{const o=document.createElement('option');o.value=id;o.textContent=id;return o;}));
  if(ids.includes(selectedModel))el('test-model').value=selectedModel;
  el('test-submit').disabled=!ids.length;
  if(catalogPlatform!==el('platform').value)await loadCatalog();
}
el('platform').onchange=()=>{el('upstream-key').value='';loadCatalog();};
el('discover-models').onclick=()=>task(el('provider-form'),async()=>{
  if(!el('upstream-key').value.trim())throw new Error('Hãy nhập API key nhà cung cấp trước.');
  if(!el('free-confirmed').checked)throw new Error('Hãy xác nhận khóa/model thuộc gói miễn phí.');
  const platform=el('platform').value;el('discovery-status').textContent='Đang kiểm tra quyền và lấy danh sách model…';
  try{const data=await api('/api/providers/discover',{platform,key:el('upstream-key').value,free_confirmed:true});if(platform!==el('platform').value)return;el('models').value=data.models.map(m=>m.id).join('\n');el('discovery-status').textContent=data.message;notice(data.message);}
  catch(e){el('discovery-status').textContent=e.message;throw e;}
});
el('login-form').addEventListener('submit',event=>{event.preventDefault();task(event.currentTarget,async()=>{await api('/api/login',{password:el('password').value});el('password').value='';await refresh();notice('Đã đăng nhập.');});});
el('logout').onclick=()=>task(el('logout').parentElement,async()=>{await api('/api/logout',{});el('dashboard').hidden=true;el('login-panel').hidden=false;el('created-key').value='';el('new-key').hidden=true;el('upstream-key').value='';notice('Đã đăng xuất.');});
el('refresh').onclick=()=>task(el('refresh').parentElement,refresh);
el('provider-form').addEventListener('submit',event=>{event.preventDefault();task(event.currentTarget,async()=>{
  const body={platform:el('platform').value,label:el('provider-label').value,key:el('upstream-key').value,models:el('models').value.split(/[\n,]/).map(x=>x.trim()).filter(Boolean),free_confirmed:el('free-confirmed').checked};
  for(const name of ['priority','rpm','rpd','tpm','tpd','concurrency'])body[name]=Number(el(name).value);
  const data=await api('/api/providers',body);el('upstream-key').value='';el('free-confirmed').checked=false;el('models').value='';await refresh();notice('Đã lưu khóa mã hóa với '+data.models.length+' model. '+(data.discovery?.message||'Chưa gửi yêu cầu AI.'));
});});
el('key-form').addEventListener('submit',event=>{event.preventDefault();task(event.currentTarget,async()=>{const data=await api('/api/keys',{label:el('key-label').value});el('created-key').value=data.key;el('new-key').hidden=false;await refresh();notice('Đã tạo khóa. Sao chép ngay; server chỉ lưu mã băm.');});});
el('copy-base').onclick=()=>navigator.clipboard.writeText(base).then(()=>notice('Đã sao chép Base URL.')).catch(()=>notice('Hãy chọn và sao chép Base URL thủ công.',true));
el('copy-key').onclick=()=>navigator.clipboard.writeText(el('created-key').value).then(()=>notice('Đã sao chép khóa.')).catch(()=>notice('Không thể truy cập clipboard.',true));
el('clear-key').onclick=()=>{el('created-key').value='';el('new-key').hidden=true;};
let active;
el('stop').onclick=()=>active?.abort();
el('playground-form').addEventListener('submit',event=>{event.preventDefault();task(event.currentTarget,async()=>{
  active=new AbortController();el('stop').disabled=false;el('test-result').textContent='Đang gọi nhà cung cấp…';
  try{
    const res=await fetch('/api/playground',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:el('test-model').value,messages:[{role:'user',content:el('prompt').value}],stream:el('stream').checked,max_tokens:256}),signal:active.signal});
    if(!res.ok){const err=await res.json().catch(()=>({}));throw new Error(err.error?.message||'Yêu cầu thất bại.');}
    if(!el('stream').checked){el('test-result').textContent=JSON.stringify(await res.json(),null,2);return;}
    const reader=res.body.getReader();const decoder=new TextDecoder();let buffer='';let output='';let ended=false;
    while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const parts=buffer.split('\n\n');buffer=parts.pop();for(const part of parts){const line=part.split('\n').find(x=>x.startsWith('data: '));if(!line)continue;const data=line.slice(6);if(data==='[DONE]'){ended=true;continue;}const item=JSON.parse(data);if(item.error)throw new Error(item.error.message);const delta=item.choices?.[0]?.delta;output+=delta?.content||delta?.reasoning_content||'';if(delta?.tool_calls)output+=JSON.stringify(delta.tool_calls);el('test-result').textContent=output||'Đang nhận kết quả…';}}
    if(!ended)throw new Error('Luồng bị ngắt trước khi hoàn tất.');
  }catch(e){el('test-result').textContent=e.name==='AbortError'?'Đã dừng yêu cầu.':e.message;throw e;}finally{active=null;el('stop').disabled=true;refresh().catch(()=>{});}
});});
api('/api/health').then(()=>{el('connection').textContent='Website/API đang phản hồi';return refresh();}).catch(e=>{if(!e.message.includes('Sign in'))notice(e.message,true);});
