// Generate NEW cloud credentials. Does not read the local Electron profile.
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
const dir = new URL('../../.cloud-private/', import.meta.url);
await mkdir(dir, { recursive: true, mode: 0o700 });
try { await access(new URL('bootstrap.json', dir)); throw new Error('Cloud credentials already exist; refusing overwrite.'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16).toString('hex');
const apiKey = `freellmapi-${randomBytes(32).toString('hex')}`;
const config = {
  DATABASE_URL: `postgresql://freellmapi_runtime.xkcdxhsibvgovdqnkhaa:${randomBytes(32).toString('hex')}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
  CLOUD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  CLOUD_SESSION_SECRET: randomBytes(32).toString('hex'),
  CLOUD_ADMIN_PASSWORD_HASH: `${salt}:${scryptSync(password, salt, 64).toString('hex')}`,
};
await writeFile(new URL('bootstrap.json', dir), JSON.stringify({ config, apiKeyDigest: createHash('sha256').update(apiKey).digest('hex') }), { mode: 0o600 });
await writeFile(new URL('runtime.env', dir), Object.entries(config).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
await writeFile(new URL('ACCESS.txt', dir), `FreeLLMAPI Cloud — private, never commit or share\n\nAdmin password: ${password}\nCloud API key: ${apiKey}\n\nThis is a NEW cloud API key; the local installation's key is unchanged.\n`, { mode: 0o600 });
console.log('New cloud credentials saved in .cloud-private. Values were not printed.');
