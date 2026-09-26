import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

// This uses workerd's MIME parser and ArrayBuffers, not a Node mock. It is a
// bounded synthetic smoke test, not a measurement of Cloudflare's production
// per-isolate memory/CPU billing or a promise for every 25 MiB MIME shape.
test('workerd parses an exact 25 MiB synthetic MIME attachment without base64 JSON copies',{timeout:60000},async()=>{
  const bundle=await build({stdin:{contents:`
    import { parseMail } from './src/native/parser.ts';
    export default {async fetch(request) {
      let stored=0;
      const result=await parseMail(await request.arrayBuffer(),{MAIL_STORE:{async put(key,bytes) {stored+=bytes.byteLength;return {key};}}},'parsed/large/test');
      return Response.json({subject:result.mail.subject,count:result.mail.attachments.length,stored,size:result.mail.attachments[0]?.size});
    }};`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),sourcefile:'large-test.ts',loader:'ts'},bundle:true,format:'esm',platform:'neutral',write:false});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-07',host:'127.0.0.1',port:0}));
  try {
    const header=Buffer.from('From: sender@example.org\r\nTo: inbox@mail.example.org\r\nSubject: Synthetic large attachment\r\nContent-Type: application/octet-stream; name="large.bin"\r\nContent-Disposition: attachment; filename="large.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n');
    const raw=Buffer.alloc(25*1024*1024);
    header.copy(raw);
    raw.fill('A'.repeat(76)+'\r\n',header.byteLength);
    const response=await mf.dispatchFetch('http://localhost/parse',{method:'POST',body:raw});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.subject,'Synthetic large attachment');assert.equal(result.count,1);assert.equal(result.stored,result.size);
    assert.ok(result.size>18*1024*1024 && result.size<20*1024*1024);
  } finally {await mf.dispose();}
});
