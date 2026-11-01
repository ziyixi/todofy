export const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>存储</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:940px;margin:40px auto;padding:0 20px;color:#20242b;background:#f7f8fa}section{background:white;border:1px solid #dce0e5;border-radius:10px;padding:24px;margin:24px 0}h1{margin-bottom:0}h2{font-size:20px;margin-top:0}label{display:block;margin:12px 0}input,select,textarea,button{font:inherit;padding:8px;border:1px solid #bbc1ca;border-radius:5px;box-sizing:border-box}input,textarea{width:100%}button{cursor:pointer;background:#f1f3f6}button:disabled{opacity:.6;cursor:wait}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #e5e7eb;overflow-wrap:anywhere}.muted{color:#5b6472}#secret{width:100%;min-height:90px}#status{min-height:26px}small{display:block} @media(max-width:600px){body{margin-top:20px}section{padding:16px}th,td{padding:6px;font-size:14px}}</style>
<script src="/assets/storage.js" defer></script></head><body>
<h1>存储</h1><p class="muted">应用文件与 Dropbox 连接</p><p id="status" role="status" aria-live="polite"></p>
<section><h2>Dropbox</h2><p id="connection">正在读取连接状态…</p><p class="muted">文件保存在 Todofy Shared Storage 的独立应用文件夹中。</p>
<form id="connect"><label>Dropbox App key<input id="app-key" required pattern="[a-z0-9]{8,32}" autocomplete="off"></label><button>连接 Dropbox</button></form>
<button id="disconnect" hidden>断开连接</button><small class="muted">断开连接会保留 Dropbox 中的文件。</small></section>
<section><h2>应用密钥</h2><form id="create"><label>名称<input id="label" required maxlength="80" placeholder="例如：Quant collector"></label>
<label>命名空间<input id="namespace" required pattern="[a-z][a-z0-9_-]{0,63}" placeholder="例如：quant"><small class="muted">使用小写字母、数字、连字符或下划线，以字母开头。</small></label>
<label>权限<select id="access"><option value="read_only">只读</option><option value="read_write">读取和条件写入</option></select></label><button>创建密钥</button></form>
<div id="issued" hidden><p>请复制此密钥。关闭或刷新页面后无法再次查看。</p><textarea id="secret" readonly aria-label="新创建的应用密钥"></textarea></div>
<table><thead><tr><th>名称</th><th>命名空间</th><th>权限</th><th>操作</th></tr></thead><tbody id="clients"></tbody></table></section></body></html>`;

export const SCRIPT = `'use strict';
const byId=(id)=>document.getElementById(id);
async function api(path,options={}){const response=await fetch('/api/v1/'+path,{...options,headers:{'Content-Type':'application/json','X-CSRF-Token':'1',...options.headers}});const body=await response.json();if(!response.ok){const reason=body.error?.details?.find((item)=>item['@type']==='type.googleapis.com/google.rpc.ErrorInfo')?.reason??'REQUEST_FAILED';throw new Error('操作失败（'+reason+'）');}return body;}
function status(text){byId('status').textContent=text;}
async function load(){const settings=await api('settings');byId('connection').textContent=settings.connected?'已连接':'未连接';byId('connect').hidden=!!settings.connected;byId('disconnect').hidden=!settings.connected;byId('app-key').value=settings.app_key??'';const result=await api('clients?page_size=64');const rows=[];for(const client of result.clients??[]){const row=document.createElement('tr');for(const value of [client.label,client.namespace,client.access==='read_write'?'读取和写入':'只读']){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}const cell=document.createElement('td');const revoke=document.createElement('button');revoke.textContent='撤销';revoke.onclick=()=>perform(revoke,async()=>{await api(client.name,{method:'DELETE'});await load();status('密钥已撤销。');});cell.append(revoke);row.append(cell);rows.push(row);}byId('clients').replaceChildren(...rows);}
async function perform(button,operation){button.disabled=true;status('');try{await operation();}catch(error){status(error.message);}finally{button.disabled=false;}}
byId('connect').onsubmit=(event)=>{event.preventDefault();perform(event.submitter,async()=>{const result=await api('dropbox:connect',{method:'POST',body:JSON.stringify({app_key:byId('app-key').value})});location.assign(result.authorize_url);});};
byId('disconnect').onclick=(event)=>perform(event.target,async()=>{await api('dropbox:disconnect',{method:'POST',body:'{}'});await load();status('已断开连接，文件保留。');});
byId('create').onsubmit=(event)=>{event.preventDefault();perform(event.submitter,async()=>{const result=await api('clients?request_id='+crypto.randomUUID(),{method:'POST',body:JSON.stringify({label:byId('label').value,namespace:byId('namespace').value,access:byId('access').value})});if(result.api_key){byId('secret').value=result.api_key;byId('issued').hidden=false;}await load();status('密钥已创建。');});};
load().catch((error)=>status(error.message));`;
