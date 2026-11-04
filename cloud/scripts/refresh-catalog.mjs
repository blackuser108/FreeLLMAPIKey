import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const file=new URL('./export-catalog.generated.mjs',import.meta.url);
await build({entryPoints:[fileURLToPath(new URL('./export-catalog.mjs',import.meta.url))],outfile:fileURLToPath(file),bundle:true,platform:'node',format:'esm',packages:'external',banner:{js:"import { createRequire as bundleRequire } from 'node:module';const require=bundleRequire(import.meta.url);"}});
const result=spawnSync(process.execPath,[fileURLToPath(file),'--sync'],{stdio:'inherit'});
if(result.status!==0)process.exitCode=1;
