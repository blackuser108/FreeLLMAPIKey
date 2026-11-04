import http from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from '../dist-handler.mjs';
const files = { '/':'index.html','/app.js':'app.js','/style.css':'style.css' };
http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if (/^\/(api|v1)(\/|$)/.test(path)) return handler(req,res);
  if (!files[path]) {res.statusCode=404;return res.end('Not found');}
  res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');
  res.end(await readFile(new URL('../public/'+files[path],import.meta.url)));
}).listen(3002,'127.0.0.1',()=>console.log('Cloud development server on http://127.0.0.1:3002 (no upstream requests at startup).'));
