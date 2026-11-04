'use strict';
const el=id=>document.getElementById(id);
const base=location.origin+'/v1';
el('base-url').textContent=base;
el('curl-example').textContent=`curl "${base}/chat/completions" \\\n  -H "Authorization: Bearer $FREELLMAPI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}],"stream":true}'`;
function notice(message,error=false){el('notice').hidden=false;el('notice').className=error?'error':'';el('notice').textContent=message;}
async function api(path,body){
  const res=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>({}));
  if(!res.ok){if(res.status===401){el('dashboard').hidden=true;el('login-panel').hidden=false;}throw new Error(data.error?.message||'Không thể kết nối dịch vụ.');}
  return data;
}
async function task(form,fn){const button=form.querySelector('button[type="submit"]');if(button)button.disabled=true;try{await fn();}catch(e){notice(e.message,true);}finally{if(button)button.disabled=false;}}
function row(title,detail,action){const li=document.createElement('li');const text=document.createElement('div');const strong=document.createElement('strong');strong.textContent=title;const small=document.createElement('small');small.textContent=detail;text.append(strong,small);li.append(text);if(action){const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=action.label;button.onclick=()=>task(li,action.run);li.append(button);}return li;}
async function refresh(){
  const state=await api('/api/state');el('dashboard').hidden=false;el('login-panel').hidden=true;el('connection').textContent='Cloud + PostgreSQL đã kết nối';
  const stats=[['Lượt thử / 24h',state.stats.attempts],['AI thành công / 24h',state.stats.succeeded],['Đang xử lý',state.stats.active],['Lượt lỗi / 24h',state.stats.failed]];
  el('stats').replaceChildren(...stats.map(([label,value])=>{const div=document.createElement('div');const strong=document.createElement('strong');strong.textContent=value;const span=document.createElement('span');span.textContent=label;div.append(strong,span);return div;}));
  el('keys').replaceChildren(...state.keys.map(k=>row(k.label,k.enabled?'Đang hoạt động':'Đã thu hồi',k.enabled?{label:'Thu hồi',run:async()=>{await api('/api/keys/revoke',{id:k.id});await refresh();notice('Đã thu hồi khóa.');}}:null)));
  el('providers').replaceChildren(...state.providers.map(p=>row(p.label+' · '+p.platform,`${p.enabled?'Bật':'Tắt'} · ${p.models.join(', ')} · ${p.rpm} lượt/phút · ${p.concurrency} đồng thời${p.cooldown_until?' · Đang cooldown đến '+new Date(p.cooldown_until).toLocaleString():''}${p.last_status?' · HTTP gần nhất: '+p.last_status:''}`,{label:p.enabled?'Tạm tắt':'Bật lại',run:async()=>{await api('/api/providers/toggle',{id:p.id,enabled:!p.enabled});await refresh();}})));
  if(!state.providers.length)el('providers').append(row('Chưa có nhà cung cấp','Thêm khóa miễn phí và model trước khi gọi AI.'));
  const ids=state.providers.filter(p=>p.enabled).flatMap(p=>p.models.map(m=>p.platform+'/'+m));
  el('test-model').replaceChildren(...['auto',...new Set(ids)].map(id=>{const o=document.createElement('option');o.value=id;o.textContent=id;return o;}));
}
el('login-form').addEventListener('submit',event=>{event.preventDefault();task(event.currentTarget,async()=>{await api('/api/login',{password:el('password').value});el('password').value='';await refresh();notice('Đã đăng nhập.');});});
el('logout').onclick=()=>task(el('dashboard'),async()=>{await api('/api/logout',{});el('dashboard').hidden=true;el('login-panel').hidden=false;el('created-key').value='';el('new-key').hidden=true;notice('Đã đăng xuất.');});
el('refresh').onclick=()=>task(el('dashboard'),refresh);
el('provider-form').addEventListener('submit',event=>{event.preventDefault();task(event.currentTarget,async()=>{
  const body={platform:el('platform').value,label:el('provider-label').value,key:el('upstream-key').value,models:el('models').value.split(/[\n,]/).map(x=>x.trim()).filter(Boolean),free_confirmed:el('free-confirmed').checked};
  for(const name of ['priority','rpm','rpd','tpm','tpd','concurrency'])body[name]=Number(el(name).value);
  await api('/api/providers',body);el('upstream-key').value='';el('free-confirmed').checked=false;await refresh();notice('Đã lưu khóa mã hóa. Chưa gửi yêu cầu AI.');
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
    const res=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+el('test-key').value},body:JSON.stringify({model:el('test-model').value,messages:[{role:'user',content:el('prompt').value}],stream:el('stream').checked,max_tokens:256}),signal:active.signal});
    if(!res.ok){const err=await res.json().catch(()=>({}));throw new Error(err.error?.message||'Yêu cầu thất bại.');}
    if(!el('stream').checked){el('test-result').textContent=JSON.stringify(await res.json(),null,2);return;}
    const reader=res.body.getReader();const decoder=new TextDecoder();let buffer='';let output='';let ended=false;
    while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const parts=buffer.split('\n\n');buffer=parts.pop();for(const part of parts){const line=part.split('\n').find(x=>x.startsWith('data: '));if(!line)continue;const data=line.slice(6);if(data==='[DONE]'){ended=true;continue;}const item=JSON.parse(data);if(item.error)throw new Error(item.error.message);const delta=item.choices?.[0]?.delta;output+=delta?.content||delta?.reasoning_content||'';if(delta?.tool_calls)output+=JSON.stringify(delta.tool_calls);el('test-result').textContent=output||'Đang nhận kết quả…';}}
    if(!ended)throw new Error('Luồng bị ngắt trước khi hoàn tất.');
  }catch(e){el('test-result').textContent=e.name==='AbortError'?'Đã dừng yêu cầu.':e.message;throw e;}finally{active=null;el('stop').disabled=true;refresh().catch(()=>{});}
});});
api('/api/health').then(()=>{el('connection').textContent='Website/API đang phản hồi';return refresh();}).catch(e=>{if(!e.message.includes('Sign in'))notice(e.message,true);});
