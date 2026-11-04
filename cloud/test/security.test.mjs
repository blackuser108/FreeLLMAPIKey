import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { encrypt, decrypt, signSession, validSession, verifyPassword, safeEqual } from '../src/security.mjs';
import { chatSchema, providerSchema, tokenReservation } from '../src/validation.mjs';
test('AES-GCM decrypts and refuses modified ciphertext, tag, and a different key',()=>{
  const key=randomBytes(32).toString('hex');const value=encrypt('test-only-provider-key',key);
  assert.equal(decrypt(value,key),'test-only-provider-key');
  assert.throws(()=>decrypt({...value,encrypted:'ff'+value.encrypted.slice(2)},key));
  assert.throws(()=>decrypt({...value,authTag:'abcd'},key));
  assert.throws(()=>decrypt(value,randomBytes(32).toString('hex')));
  assert.throws(()=>encrypt('test','placeholder'));
});
test('sessions expire, reject tampering and cannot be reused with another secret',()=>{
  const session=signSession('test-secret',1000);
  assert.ok(validSession(session,'test-secret',1001));
  assert.equal(validSession(session,'other-secret',1001),false);
  assert.equal(validSession(session+'x','test-secret',1001),false);
  assert.equal(validSession(session,'test-secret',1000+12*3600000),false);
});
test('admin password hashes and constant-time comparisons reject malformed values',()=>{
  const salt=randomBytes(16).toString('hex');const hash=salt+':'+scryptSync('test-password',salt,64).toString('hex');
  assert.ok(verifyPassword('test-password',hash));assert.equal(verifyPassword('wrong-password',hash),false);
  assert.equal(verifyPassword('test','bad'),false);assert.equal(safeEqual('a','aa'),false);
});
test('input boundary rejects arbitrary upstreams and unsupported image payloads',()=>{
  const body={model:'auto',messages:[{role:'user',content:'hello'}]};
  assert.ok(chatSchema.safeParse(body).success);
  assert.equal(chatSchema.safeParse({...body,base_url:'http://169.254.169.254'}).success,false);
  assert.equal(chatSchema.safeParse({...body,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'http://localhost'}}]}]}).success,false);
  assert.equal(chatSchema.safeParse({...body,max_tokens:500000}).success,false);
  assert.equal(chatSchema.safeParse({...body,max_tokens:1,max_completion_tokens:2}).success,false);
  assert.equal(providerSchema.safeParse({platform:'custom',label:'x',key:'test-key',models:['x'],free_confirmed:true}).success,false);
  assert.equal(providerSchema.safeParse({platform:'groq',label:'x',key:'test-key',models:['x'],free_confirmed:false}).success,false);
  assert.ok(tokenReservation({...body,max_tokens:100})>100);
});
