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
      return Response.json({subject:result.mail.subject,text:result.mail.text,review:result.mail.needs_review,count:result.mail.attachments.length,stored,size:result.mail.attachments[0]?.size,status:result.mail.attachments[0]?.storage_status,reason:result.mail.attachments[0]?.omitted_reason});
    }};`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),sourcefile:'large-test.ts',loader:'ts'},bundle:true,format:'esm',platform:'neutral',conditions:['browser'],write:false});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-07',host:'127.0.0.1',port:0}));
  try {
    const header=Buffer.from('From: sender@example.org\r\nTo: inbox@mail.example.org\r\nSubject: Synthetic large attachment\r\nContent-Type: application/octet-stream; name="large.bin"\r\nContent-Disposition: attachment; filename="large.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n');
    const raw=Buffer.alloc(25*1024*1024);
    header.copy(raw);
    raw.fill('A'.repeat(76)+'\r\n',header.byteLength);
    const response=await mf.dispatchFetch('http://localhost/parse',{method:'POST',body:raw});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.subject,'Synthetic large attachment');assert.equal(result.count,1);assert.equal(result.stored,0);
    assert.equal(result.status,'omitted');assert.equal(result.reason,'size_limit');
    assert.ok(result.size>18*1024*1024 && result.size<20*1024*1024);

    // The same platform-size budget split across MIME attachments must retain
    // usable text, without ever writing the oversized decoded copies.
    const start=Buffer.from('Subject: Synthetic multiple attachments\r\nContent-Type: multipart/mixed; boundary=largefixture\r\n\r\n--largefixture\r\nContent-Type: text/plain\r\n\r\nUsable body\r\n--largefixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="one.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n');
    const middle=Buffer.from('\r\n--largefixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="two.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n');
    const end=Buffer.from('\r\n--largefixture--\r\n');
    const contentBytes=25*1024*1024-start.length-middle.length-end.length;
    const first=Buffer.alloc(Math.floor(contentBytes/2)).fill('A'.repeat(76)+'\r\n');
    const second=Buffer.alloc(contentBytes-first.length).fill('A'.repeat(76)+'\r\n');
    const multi=Buffer.concat([start,first,middle,second,end]);
    assert.equal(multi.length,25*1024*1024);
    const multipleResponse=await mf.dispatchFetch('http://localhost/parse',{method:'POST',body:multi});
    assert.equal(multipleResponse.status,200);
    const multiple=await multipleResponse.json();
    assert.equal(multiple.count,2);assert.equal(multiple.stored,0);
    assert.equal(multiple.text,'Usable body');assert.equal(multiple.review,false);
  } finally {await mf.dispose();}
});
