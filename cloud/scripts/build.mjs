import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../../', import.meta.url);
const output = new URL('.vercel/output/', root);
const func = new URL('functions/gateway.func/', output);
const cloudAliases={zod:fileURLToPath(new URL('../node_modules/zod/index.js',import.meta.url)),'fast-uri':fileURLToPath(new URL('../node_modules/fast-uri/index.js',import.meta.url))};
const cloudDefines={__SUPABASE_CA__:JSON.stringify(await readFile(new URL('../supabase-ca.pem',import.meta.url),'utf8'))};
await mkdir(func,{recursive:true});
// Official Build Output API: https://vercel.com/docs/build-output-api
// Original provider modules are bundled, no SQLite DB/Windows process is started.
const result = await build({ entryPoints:[fileURLToPath(new URL('../src/handler.mjs',import.meta.url))], outfile:fileURLToPath(new URL('index.mjs',func)),
  bundle:true,platform:'node',target:'node24',format:'esm',sourcemap:false,
  metafile:true,alias:cloudAliases,define:cloudDefines,
  external:['better-sqlite3','sharp','undici','socks-proxy-agent','pg-native'],
  banner:{js:"import { createRequire as cloudCreateRequire } from 'node:module'; const require = cloudCreateRequire(import.meta.url);"},
});
await mkdir(new URL('../dist/',import.meta.url),{recursive:true});
await writeFile(new URL('../dist/metafile.json',import.meta.url),JSON.stringify(result.metafile));
await cp(new URL('index.mjs',func),new URL('../dist-handler.mjs',import.meta.url));
// Test harness exposes the same original adapters without adding a public route.
await build({entryPoints:[fileURLToPath(new URL('../src/providers.mjs',import.meta.url))],outfile:fileURLToPath(new URL('../dist-providers.mjs',import.meta.url)),bundle:true,platform:'node',target:'node24',format:'esm',alias:cloudAliases,define:cloudDefines,external:['better-sqlite3','sharp','undici','socks-proxy-agent'],banner:{js:"import { createRequire as cloudCreateRequire } from 'node:module'; const require = cloudCreateRequire(import.meta.url);"}});
await writeFile(new URL('.vc-config.json',func),JSON.stringify({runtime:'nodejs24.x',handler:'index.mjs',launcherType:'Nodejs',supportsResponseStreaming:true,maxDuration:300}));
await mkdir(new URL('static/',output),{recursive:true});
await cp(new URL('../public/',import.meta.url),new URL('static/',output),{recursive:true});
const csp="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";
await writeFile(new URL('config.json',output),JSON.stringify({ version:3,routes:[
  {src:'/(.*)',headers:{'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':csp,'Strict-Transport-Security':'max-age=31536000'},continue:true},
  {src:'/(api|v1)(/.*)?',dest:'/gateway',headers:{'Cache-Control':'no-store'}},
  {handle:'filesystem'},
  {src:'/',dest:'/index.html',headers:{'Cache-Control':'no-cache'}},
  {src:'/(.*)',status:404,dest:'/404.html'},
]},null,2));
console.log('Built real FreeLLMAPI cloud handler and management UI. No provider requests were made.');
