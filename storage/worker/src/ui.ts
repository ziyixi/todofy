// The owner console: one HTML document and one same-origin script (CSP script-src 'self'), in Home and Fleet's
// light warm-paper, ink-blue style. Status words carry a shape; colour only reinforces them. No polling.
const STYLE = String.raw`
:root{color-scheme:light;--bg:#f3f1ec;--surface:#fcfbf8;--surface-2:#f6f4ef;--fg:#1d2126;--fg-2:#3a3f46;--muted:#5a5f66;
--faint:#8c8578;--border:#dcd7cc;--line:#eeeae2;--axis:#cfc9bc;--accent:#2b5c8a;--accent-bg:#e4ecf4;--ok:#1e6b43;
--warn:#7a4b00;--warn-bar:#d29a2c;--bad:#9a2b21;--bad-bar:#b8392e;--bad-bg:#f8eeeb;--unknown:#46536a;--notice-bg:#fbf1dc;
--s1:#2b5c8a;--s2:#1b6a64;--s3:#b9ae98;--mono:ui-monospace,'SF Mono',Menlo,monospace}
*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Noto Sans SC','Microsoft YaHei',system-ui,sans-serif;
font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
main{max-width:1120px;margin:0 auto;padding:32px 24px 48px}
h1,h2,h3,p,dl,dd,ul{margin:0}ul{padding:0;list-style:none}
h1{font-size:clamp(1.5rem,3.4vw,1.9rem);font-weight:700;letter-spacing:.01em}h2{font-size:1.05rem;font-weight:700}h3{font-size:.95rem;font-weight:650}
code{font-family:var(--mono);font-size:.84rem;overflow-wrap:anywhere}a{color:var(--accent)}
.muted{color:var(--muted);font-size:.87rem}.eyebrow{font-size:.72rem;letter-spacing:.14em;color:var(--muted);margin-bottom:6px}
button,input{font:inherit;color:var(--fg)}
button{font-size:.9rem;border:1px solid var(--border);border-radius:8px;padding:7px 14px;background:var(--surface);white-space:nowrap;cursor:pointer}
button:hover{background:var(--surface-2)}button:disabled{opacity:.55;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:#fcfbf8}button.primary:hover{background:#234b72}
button.quiet{border-color:transparent;background:transparent;color:var(--muted);padding:6px 8px}button.quiet:hover{color:var(--fg);background:var(--surface-2)}
button.danger{color:var(--bad);border-color:#e3a59d;background:var(--bad-bg)}
a:focus-visible,button:focus-visible,input:focus-visible,.seg input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.masthead{display:flex;gap:20px;align-items:flex-end;justify-content:space-between}.masthead .muted{margin-top:6px}
.refresh{display:flex;align-items:center;gap:12px}
.tabs{display:flex;gap:28px;margin:24px 0 22px;border-bottom:1px solid var(--border)}
.tabs a{padding:8px 0 10px;margin-bottom:-1px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent}
.tabs a[aria-current=page]{color:var(--fg);font-weight:650;border-bottom-color:var(--accent)}
section{border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:22px 24px;margin-bottom:16px}
.head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px;margin-bottom:14px}.head .muted{font-size:.82rem}
.mark{white-space:nowrap;font-weight:600}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.unknown{color:var(--unknown)}
.status h2{font-size:1.35rem}.status .line{color:var(--fg-2);margin-top:6px}.status .past{margin-top:2px}
.notice{margin-top:14px;border-radius:8px;padding:10px 14px;background:var(--notice-bg);color:var(--fg-2)}
.notice.bad{background:var(--bad-bg)}.notice.calm{background:var(--surface-2);border:1px solid var(--line)}.notice p+p{margin-top:2px;color:var(--muted);font-size:.87rem}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:18px}
.tiles>div{background:var(--surface);padding:14px 16px 16px;min-width:0}
.tiles dt,.tiles dd{font-size:.82rem;color:var(--muted)}.tiles dt{margin-bottom:4px}
.tiles dd.value{font-size:1.45rem;font-weight:600;color:var(--fg);line-height:1.3;margin-bottom:6px}
.tiles dd.value small{font-size:.85rem;font-weight:500;color:var(--muted);margin-left:4px}.tiles dd.value.idle{color:var(--faint)}
.meter{display:block;height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin:2px 0 8px}
.meter>span{display:block;height:100%;border-radius:3px;background:var(--accent)}.meter.warn>span{background:var(--warn-bar)}.meter.bad>span{background:var(--bad-bar)}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:.82rem;color:var(--fg-2)}
.legend li{display:flex;align-items:center;gap:6px}.key{display:inline-block;width:10px;height:10px;border-radius:2px}
#trend svg{display:block;width:100%;height:auto;margin-top:8px}.axis{font-size:11px;fill:var(--muted)}.grid{stroke:var(--line)}.base{stroke:var(--axis)}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0}
.card header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 12px;margin-bottom:6px}
.card header code{font-size:1rem;font-weight:600}.card p{color:var(--fg-2);font-size:.88rem}.card p.muted{color:var(--muted);font-size:.82rem}
.objects{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}.folders{display:grid;grid-template-columns:minmax(0,8em) minmax(0,1fr) auto;gap:4px 10px;margin-top:6px}
.folders li{display:grid;grid-column:1/-1;grid-template-columns:subgrid;gap:4px 10px;align-items:center;font-size:.82rem}
.folders code,.folders .root{font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.folders .root{color:var(--muted)}.folders .size{color:var(--muted);text-align:right;white-space:nowrap}
.bar{display:block;height:4px;border-radius:2px;background:var(--line);overflow:hidden}.bar>span{display:block;height:100%;background:var(--s1);opacity:.75}
.scan{margin:-6px 0 14px}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:32px}
.facts div{display:grid;grid-template-columns:7em 1fr;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);min-width:0}
.facts dt{color:var(--muted);font-size:.87rem}.facts dd{min-width:0;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-top:16px}
.confirm{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:10px 12px;border-radius:8px;background:var(--bad-bg);font-size:.88rem;color:var(--fg-2)}
.confirm span{flex:1 1 16em}
.group+.group{margin-top:18px}.group>h3{display:flex;gap:10px;align-items:baseline;margin-bottom:6px}
h2 .muted{font-weight:400;margin-left:4px}.group>h3 span{font-weight:400;color:var(--muted);font-size:.82rem}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 16px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}
.row .name{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;font-weight:600;min-width:0;overflow-wrap:anywhere}
.row .meta{grid-column:1;color:var(--muted);font-size:.84rem}.row .confirm{grid-column:1/-1}
.badge{display:inline-block;font-size:.75rem;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border);color:var(--fg-2)}
.badge.rw{background:var(--accent-bg);border-color:#b8cde2;color:var(--accent)}
form.create{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) auto auto;gap:12px;align-items:end;padding:16px;margin-bottom:16px;border-radius:10px;background:var(--surface-2);border:1px solid var(--line)}
form label{display:grid;gap:4px;font-size:.84rem;color:var(--muted)}form.connect{display:flex;flex-wrap:wrap;align-items:end;gap:12px}
input{width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:9px;padding:2px;background:var(--surface)}
.seg label{position:relative;display:block}.seg input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer;width:auto}
.seg span{display:block;padding:5px 12px;border-radius:7px;font-size:.87rem;color:var(--muted);white-space:nowrap}
.seg input:checked+span{background:var(--accent-bg);color:var(--accent);font-weight:650}
.issued{margin-bottom:16px;padding:14px 16px;border-radius:10px;border:1px solid #e2c27f;background:var(--notice-bg)}
.issued .secret{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:8px}
.issued code{flex:1 1 20em;min-width:0;padding:8px 10px;border-radius:8px;background:var(--surface);border:1px solid var(--border)}
.table-scroll{overflow:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:.86rem}
th,td{text-align:right;padding:6px 12px;border-top:1px solid var(--line);white-space:nowrap}
thead th{background:var(--surface-2);font-weight:600;border-top:0}th:first-child,td:first-child{text-align:left}td.zero{color:var(--faint)}
.events li{display:grid;grid-template-columns:7.5em minmax(0,1fr) auto;gap:4px 16px;padding:10px 0;border-top:1px solid var(--line);align-items:baseline}
.events li:first-child{border-top:0}.events time{color:var(--muted);font-size:.84rem}.events .what{min-width:0}
.events .who{display:block;color:var(--muted);font-size:.82rem}.events .detail{color:var(--muted);font-size:.82rem;text-align:right}
.note{margin-top:12px;color:var(--muted);font-size:.82rem}.note+.note{margin-top:4px}.empty{color:var(--muted);padding:6px 0}
footer{margin-top:24px;font-size:.85rem;color:var(--muted)}
#status:empty{display:none}#status{margin:-8px 0 16px;color:var(--fg-2)}[role=alert]{color:var(--bad)}
@media(max-width:860px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.cards,.facts{grid-template-columns:1fr}form.create{grid-template-columns:1fr 1fr}}
@media(max-width:600px){main{padding:20px 16px 40px}.masthead{flex-direction:column;align-items:flex-start;gap:12px}
section{padding:18px 16px;border-radius:10px}.tabs{gap:24px;margin-top:18px}.tiles>div{padding:12px}.tiles dd.value{font-size:1.15rem}
form.create{grid-template-columns:1fr}.seg{display:flex}.seg label{flex:1}.seg span{text-align:center}
.folders li{grid-template-columns:minmax(0,1fr) auto}.folders .size{grid-area:1/2}.folders .bar{grid-area:2/1/3/3}
.facts div{grid-template-columns:6em 1fr}.events li{grid-template-columns:1fr}.events .detail{text-align:left}}
`;

export const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>存储</title>
<style>${STYLE}</style><script src="/assets/storage.js" defer></script></head><body><main>
<header class="masthead"><div><p class="eyebrow">PERSONAL CLOUD / STORAGE</p><h1>存储</h1>
<p class="muted">应用用命名空间密钥读写独立的 Dropbox 应用文件夹。断开连接或撤销密钥都不会删除文件。</p></div>
<div class="refresh"><span id="updated" class="muted"></span><button id="refresh" type="button">刷新</button></div></header>
<nav class="tabs" aria-label="视图"><a href="#overview">概览</a><a href="#keys">密钥</a><a href="#activity">活动</a></nav>
<p id="status" role="status" aria-live="polite"></p>
<div data-view="overview"><section class="status" id="summary"><p class="muted">正在读取状态…</p></section>
<section id="trend" hidden></section><section id="namespaces" hidden></section><section id="connection" hidden></section></div>
<div data-view="keys" hidden><section id="keys"><p class="muted">正在读取密钥…</p></section></div>
<div data-view="activity" hidden><section id="failures"><p class="muted">正在读取活动…</p></section><section id="daily" hidden></section><section id="operations" hidden></section></div>
<footer id="footer"></footer></main></body></html>`;

export const SCRIPT = String.raw`'use strict';
const byId=(id)=>document.getElementById(id);
const fill=(id,...children)=>byId(id).replaceChildren(...children.flat().filter((c)=>c!=null&&c!==false&&c!==''));
function h(tag,props,...children){const el=document.createElement(tag);for(const [k,v] of Object.entries(props??{})){if(v==null||v===false)continue;
if(k==='class')el.className=v;else if(k==='text')el.textContent=v;else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else el.setAttribute(k,v===true?'':String(v));}
for(const c of children.flat(3))if(c!=null&&c!==false)el.append(c);return el;}
function svg(tag,attrs,text){const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));if(text!=null)el.textContent=text;return el;}
const SHAPE={ok:'●',warn:'▲',bad:'■',unknown:'◆'};
const mark=(tone,text)=>h('span',{class:'mark '+tone},h('span',{'aria-hidden':'true',text:SHAPE[tone]+' '}),text);
const num=(n)=>Number(n??0).toLocaleString('zh-CN');
function bytes(n){n=Number(n??0);const u=['B','KiB','MiB','GiB','TiB'];let e=0;while(e<u.length-1&&n>=1024**(e+1))e++;const x=n/1024**e;
return(e===0?String(Math.round(x)):x>=100?x.toFixed(0):x>=10?x.toFixed(1):x.toFixed(2))+' '+u[e];}
const percent=(f)=>Math.floor(f*100)+'%';
const pad=(n)=>String(n).padStart(2,'0');
const clock=(t)=>{const d=new Date(t);return pad(d.getHours())+':'+pad(d.getMinutes());};
const date=(t)=>{const d=new Date(t);return d.getFullYear()+'/'+pad(d.getMonth()+1)+'/'+pad(d.getDate());};
function when(t){if(!t)return'—';const d=new Date(t);if(d.toDateString()===new Date().toDateString())return'今天 '+clock(t);
return(d.getFullYear()===new Date().getFullYear()?(d.getMonth()+1)+'/'+d.getDate():date(t))+' '+clock(t);}
function duration(a,b){const m=Math.round((Date.parse(b)-Date.parse(a))/60000);return m<1?'不到 1 分钟':m<60?m+' 分钟':Math.floor(m/60)+' 小时 '+(m%60)+' 分';}
function ago(t){const m=Math.round((Date.now()-new Date(t).getTime())/60000);if(m<1)return'刚刚';if(m<60)return m+' 分钟前';if(m<1440)return Math.round(m/60)+' 小时前';return Math.round(m/1440)+' 天前';}
const DAY=86400000;const utcDay=(offset=0)=>new Date(Date.now()-offset*DAY).toISOString().slice(0,10);
const shortDay=(d)=>Number(d.slice(5,7))+'/'+Number(d.slice(8));
const OPS={stat:'查询',list:'列表',get:'读取',head:'元数据',put:'写入',batch_create:'批量写入'};
const ORDINARY=new Set(['ok','not_found','conflict']);
const isFailed=(r)=>!ORDINARY.has(r.outcome)&&r.outcome!=='rate_limited';
const isWrite=(r)=>r.operation==='put'||r.operation==='batch_create';
const REASONS={
INSUFFICIENT_SPACE:['bad','Dropbox 空间不足','写入返回 507。释放 Dropbox 空间后写入会自动恢复，无需重新连接。'],
CONNECTION_INVALID:['bad','Dropbox 授权失效','断开后重新连接 Dropbox；应用密钥和文件不受影响。'],
NOT_CONFIGURED:['bad','尚未连接 Dropbox','连接之前，所有应用读写都会失败。'],
UNAVAILABLE:['warn','Dropbox 暂时限流或不可用','通常会自行恢复；调用方按 Retry-After 等待后重试。'],
PROVIDER_RESPONSE_INVALID:['warn','Dropbox 返回了无法识别的响应','查看“活动”中的最近异常。'],
BAD_REQUEST:['warn','请求格式无效','检查调用方发送的参数。'],
BATCH_INCOMPLETE:['warn','批量写入结果不完整','部分对象可能已经写入；调用方逐个确认后再推进检查点。'],
BATCH_NOT_COMMITTED:['warn','批量写入未提交','没有写入任何对象，调用方可以原样重发。'],
UPLOAD_HASH_MISMATCH:['warn','上传内容与清单哈希不符','该批没有提交。'],
UPLOAD_LENGTH_MISMATCH:['warn','上传长度与声明不符','该次写入没有提交。'],
UPLOAD_TOO_LARGE:['warn','对象超过 32 MiB 上限','拆分后再写入。'],
WRITE_PRECONDITION_REQUIRED:['warn','写入缺少条件','写入必须带 If-None-Match 或 If-Match。'],
READ_ONLY:['warn','只读密钥尝试写入','确认调用方使用了正确的密钥。'],
CURSOR_INVALID:['warn','列表续页无效','从第一页重新列出。'],
RANGE_NOT_SATISFIABLE:['warn','读取范围超出对象','检查 Range。'],
INTERNAL:['warn','存储服务内部错误','查看 Worker 日志。'],
SCAN_PAGE_LIMIT:['warn','超过 1,000 页的扫描上限','约一百万个对象之后停止，结果不完整。']};
function reason(code,status){if(code==='UNAVAILABLE'&&status&&status!==429)return{tone:'warn',title:'Dropbox 暂不可用',hint:REASONS.UNAVAILABLE[2]};
if(code==='UNAVAILABLE'&&status===429)return{tone:'warn',title:'被 Dropbox 限流',hint:REASONS.UNAVAILABLE[2]};
const r=REASONS[code];return r?{tone:r[0],title:r[1],hint:r[2]}:{tone:'warn',title:'请求失败（'+code+'）',hint:''};}
const ERRORS={UNAUTHORIZED:'登录已过期，请刷新页面。',NOT_CONFIGURED:'尚未连接 Dropbox。',CSRF_FAILED:'页面已过期，请刷新后重试。',BAD_REQUEST:'输入无效，请检查后重试。',
CLIENT_LIMIT:'已达到 64 个密钥的上限，请先撤销不再使用的密钥。',NOT_FOUND:'密钥不存在或已经撤销。',
CONNECTION_INVALID:'Dropbox 已连接或授权已变化，请刷新页面查看当前状态。',REVISION_CONFLICT:'状态已变化，请刷新后重试。',
UNAVAILABLE:'服务暂时不可用，请稍后重试。',INTERNAL:'服务内部错误，请稍后重试。',REQUEST_FAILED:'请求失败，请刷新页面后重试。'};
async function api(path,options={}){let response;try{response=await fetch('/api/v1/'+path,{...options,headers:{'Content-Type':'application/json','X-CSRF-Token':'1'}});}
catch{throw new Error('网络连接失败，请稍后重试。');}
const body=await response.json().catch(()=>null);if(!response.ok){
const code=body?.error?.details?.find((d)=>d['@type']==='type.googleapis.com/google.rpc.ErrorInfo')?.reason??'REQUEST_FAILED';
throw new Error(ERRORS[code]??'操作失败（'+code+'）');}return body;}
const status=(text)=>{byId('status').textContent=text;};
async function perform(button,operation){if(button)button.disabled=true;status('');try{await operation();}catch(error){status(error.message);}finally{if(button)button.disabled=false;}}
let state=null;let issued='';let creating=false;
const usage=()=>state?.usage??[];const clients=()=>state?.clients??[];
const sum=(rows,field,pred=()=>true)=>rows.reduce((t,r)=>t+(pred(r)?Number(r[field]??0):0),0);
const daysAgo=(rows,n)=>rows.filter((r)=>r.day===utcDay(n));
const today=()=>daysAgo(usage(),0);
function namespaces(){const m=new Map();const of=(n)=>{if(!m.has(n))m.set(n,{name:n,keys:[]});return m.get(n);};
for(const c of clients())of(c.namespace).keys.push(c);for(const r of usage())of(r.namespace);for(const n of state.object_scan?.namespaces??[])of(n.namespace);
return [...m.values()].sort((a,b)=>a.name.localeCompare(b.name));}

function overall(){const s=state.settings??{};
if(!s.connected)return{tone:'unknown',title:'未连接 Dropbox',line:'连接后，应用密钥才能读写文件。'};
const time=(v)=>v?Date.parse(v):0,errTime=time(s.last_provider_error_time),okTime=time(s.last_success_time);
// A full Dropbox still answers reads, so only a later successful write shows that space was freed.
const since=s.last_provider_error==='INSUFFICIENT_SPACE'?time(s.last_write_success_time):okTime;
const t=today(),failed=sum(t,'request_count',isFailed),limited=sum(t,'request_count',(r)=>r.outcome==='rate_limited');
const line=['Dropbox 已连接',okTime?'最近成功 '+ago(okTime):'尚无成功请求',failed?'本 UTC 日 '+num(failed)+' 次失败':limited?'本 UTC 日限流 '+num(limited)+' 次':'本 UTC 日无异常'].join(' · ');
if(s.last_provider_error&&errTime>=since){const r=reason(s.last_provider_error);
return{tone:r.tone,title:r.tone==='bad'?'需要处理':'需要注意',line,notice:{tone:r.tone,title:r.title+' · '+when(errTime),hint:r.hint}};}
const past=s.last_provider_error?'最近一次错误“'+reason(s.last_provider_error).title+'”（'+when(errTime)+'）之后已恢复。':'';
const f=spaceFraction();
if(f!==null&&f>=.9)return{tone:'warn',title:'需要注意',line,past,notice:{tone:'warn',title:'Dropbox 空间已用 '+percent(f),hint:'空间用尽后写入会返回 507；释放空间后自动恢复。'}};
if(failed)return{tone:'warn',title:'需要注意',line,past,notice:{tone:'warn',title:'本 UTC 日有 '+num(failed)+' 次请求失败',hint:'原因见“活动”。'}};
return{tone:'ok',title:'运行正常',line,past};}

function spaceFraction(){const sp=state.space;return sp?.state==='observed'&&sp.allocated_bytes>0?Number(sp.used_bytes??0)/sp.allocated_bytes:null;}
function spaceTile(){const sp=state.space,f=spaceFraction();
if(f!==null){const read=Date.now()-Date.parse(sp.observe_time)>900000?' · 读取于 '+when(sp.observe_time):'';
return tile('Dropbox 空间',h('dd',{class:'value'},percent(f),h('small',{text:'已用'})),meter(f,f>=.95?'bad':f>=.85?'warn':''),
bytes(sp.used_bytes)+' / '+bytes(sp.allocated_bytes)+read,'整个 Dropbox 账户');}
if(sp?.state==='scope_missing')return tile('Dropbox 空间',h('dd',{class:'value idle',text:'—'}),'需重新授权后显示','步骤见下方“Dropbox 连接”');
return tile('Dropbox 空间',h('dd',{class:'value idle',text:'—'}),state.settings?.connected?'暂时无法读取':'未连接');}
function tile(label,value,...details){return h('div',{},h('dt',{text:label}),value,details.map((d)=>typeof d==='string'?h('dd',{text:d}):h('dd',{},d)));}
function meter(fraction,tone){return h('span',{class:'meter '+(tone??'')},h('span',{style:'width:'+Math.min(100,fraction*100).toFixed(1)+'%'}));}
function renderSummary(){const o=overall(),t=today();
const requests=sum(t,'request_count'),share=requests/100000;
const written=sum(t,'object_count',isWrite),batches=t.filter((r)=>r.operation==='batch_create'&&r.outcome==='ok');
const batchCount=sum(batches,'request_count'),reads=sum(t,'request_count',(r)=>['get','head','stat'].includes(r.operation));
fill('summary',h('h2',{},mark(o.tone,o.title)),h('p',{class:'line',text:o.line}),o.past?h('p',{class:'muted past',text:o.past}):null,
o.notice?h('div',{class:'notice '+(o.notice.tone==='bad'?'bad':'')},h('p',{},h('strong',{},mark(o.notice.tone,o.notice.title))),o.notice.hint?h('p',{text:o.notice.hint}):null):null,
h('dl',{class:'tiles'},
spaceTile(),
tile('本 UTC 日应用请求',h('dd',{class:'value',text:num(requests)}),meter(share,share>=.5?'warn':''),'占全账户每日 10 万免费请求的 '+(share*100).toFixed(1)+'% · UTC 0 点重置'),
tile('本 UTC 日写入',h('dd',{class:'value'},num(written),h('small',{text:'个对象'})),bytes(sum(t,'upload_bytes'))+(batchCount?' · '+num(batchCount)+' 批，平均 '+(sum(batches,'object_count')/batchCount).toFixed(1)+' 个':'')),
tile('本 UTC 日读取',h('dd',{class:'value'},num(reads),h('small',{text:'次'})),'下载 '+bytes(sum(t,'download_bytes'))+' · 列表 '+num(sum(t,'request_count',(r)=>r.operation==='list'))+' 页')));}

function renderTrend(){const box=byId('trend');box.hidden=false;
const days=[...Array(14)].map((_,i)=>utcDay(13-i));
const busy=namespaces().map((n)=>[n.name,sum(usage(),'request_count',(r)=>r.namespace===n.name)]).filter((e)=>e[1]>0).sort((a,b)=>b[1]-a[1]).map((e)=>e[0]);
const top=busy.slice(0,2),series=[...top,...(busy.length>2?['其他']:[])],colors=['var(--s1)','var(--s2)','var(--s3)'];
const totals=days.map((d)=>{const v=Object.fromEntries(series.map((x)=>[x,0]));for(const r of usage())if(r.day===d&&(r.request_count??0)>0)v[top.includes(r.namespace)?r.namespace:'其他']+=r.request_count;return v;});
const max=Math.max(1,...totals.map((v)=>Object.values(v).reduce((a,b)=>a+b,0)));const step=10**Math.floor(Math.log10(Math.max(10,max)));const ceiling=Math.max(10,Math.ceil(max/step)*step);
const W=Math.max(300,Math.round(box.clientWidth-(innerWidth<=600?32:48))),H=W<600?150:190,L=46,B=24,bw=(W-L)/14,every=W<600?4:2,y=(v)=>(H-B)-(v/ceiling)*(H-B-8);
const chart=svg('svg',{viewBox:'0 0 '+W+' '+H,width:W,height:H,role:'img','aria-label':'近 14 天每日应用请求'});
for(const f of [0,.5,1])chart.append(svg('line',{class:f?'grid':'base',x1:L,x2:W,y1:y(ceiling*f),y2:y(ceiling*f)}),svg('text',{class:'axis',x:L-8,y:y(ceiling*f)+4,'text-anchor':'end'},num(ceiling*f)));
totals.forEach((v,i)=>{let base=0;const x=L+i*bw+bw*.18,w=bw*.64,g=svg('g',{});const total=Object.values(v).reduce((a,b)=>a+b,0);
g.append(svg('title',{},days[i]+'：'+num(total)+' 次'+(series.length?'（'+series.map((n)=>n+' '+num(v[n])).join('，')+'）':'')));
series.forEach((n,j)=>{if(!v[n])return;const yTop=y(base+v[n]);g.append(svg('rect',{x,y:yTop,width:w,height:Math.max(1,y(base)-yTop),fill:colors[j],rx:2,opacity:i===13?.6:1}));base+=v[n];});
chart.append(g);if((13-i)%every===0)chart.append(svg('text',{class:'axis',x:x+w/2,y:H-6,'text-anchor':'middle'},shortDay(days[i])));});
fill('trend',h('div',{class:'head'},h('h2',{text:'近 14 天应用请求'}),h('ul',{class:'legend'},series.map((n,j)=>h('li',{},h('span',{class:'key',style:'background:'+colors[j]}),n==='其他'?n:h('code',{text:n}))))),chart,
h('p',{class:'note',text:'按 UTC 日统计带有效密钥的请求，最右侧本 UTC 日的柱仍在累计。全账户 Workers 用量见 Home。'}),
state.usage_truncated?h('p',{class:'note',text:'计数行超过上限，较早几天的部分数据未显示。'}):null);}

const SCAN_STALE=600000;
const scanStale=(s)=>s.state==='running'&&Date.now()-Date.parse(s.update_time)>=SCAN_STALE;
function scanSummary(){const s=state.object_scan;
if(!s)return h('p',{class:'note scan',text:'对象数量和占用需要扫描：逐页列出 Dropbox 应用文件夹并合计，只读，不改动任何文件；请选应用空闲的时候。'});
const listed=num(s.object_count)+' 个对象 · '+bytes(s.total_bytes);
if(s.state==='succeeded')return h('p',{class:'note scan',text:'扫描于 '+when(s.end_time)+' · 共 '+listed+' · 用时 '+duration(s.start_time,s.end_time)});
if(s.state==='failed')return h('p',{class:'note scan'},mark('warn','扫描未完成'),' '+reason(s.failure_reason).title+'（'+when(s.end_time)+'）· 已列出 '+listed+'，结果不完整。');
if(scanStale(s))return h('p',{class:'note scan'},mark('warn','扫描已中断'),' '+when(s.update_time)+' 之后没有进展 · 已列出 '+listed+'，可以重新扫描。');
return h('p',{class:'note scan'},mark('unknown','正在后台扫描'),' 已列出 '+listed+'（'+num(s.page_count)+' 页）· 点“刷新”查看进度。');}
function scanButton(){const s=state.object_scan,running=s!=null&&s.state==='running'&&!scanStale(s);
return h('button',{type:'button',text:running?'扫描中…':s?'重新扫描':'扫描对象',disabled:running||!state.settings?.connected,
onclick:(e)=>perform(e.currentTarget,async()=>{await api('objectScan:start',{method:'POST',body:'{}'});await load();status('扫描已在后台开始，稍后点“刷新”查看结果。');})});}
function objectsBlock(name){const s=state.object_scan;if(!s)return h('p',{class:'muted',text:'对象数量与占用尚未扫描'});
const n=(s.namespaces??[]).find((x)=>x.namespace===name),done=s.state==='succeeded';
if(!n)return h('p',{class:'muted',text:done?'应用文件夹中没有对象':'扫描尚未列到对象'});
const total=Number(n.total_bytes??0);
return h('div',{class:'objects'},h('p',{text:num(n.object_count)+' 个对象 · '+bytes(total)+(n.recent_bytes?' · 近 7 天写入 '+bytes(n.recent_bytes):'')+(done?'':'（未完成）')}),
h('ul',{class:'folders','aria-label':'按顶层目录'},(n.folders??[]).map((f)=>{const size=Number(f.total_bytes??0);return h('li',{},f.folder?h('code',{text:f.folder}):h('span',{class:'root',text:'根目录'}),
h('span',{class:'bar','aria-hidden':'true'},h('span',{style:'width:'+(total?Math.max(1,size/total*100):0).toFixed(1)+'%'})),
h('span',{class:'size',text:bytes(size)+(f.recent_bytes?' · 7 天 +'+bytes(f.recent_bytes):'')}));})));}
function renderNamespaces(){const box=byId('namespaces');box.hidden=false;const list=namespaces();
const cards=list.map((n)=>{const rw=n.keys.filter((k)=>k.access==='read_write').length,ro=n.keys.length-rw;const rows=usage().filter((r)=>r.namespace===n.name);
const last=n.keys.map((k)=>k.last_use_time).filter(Boolean).sort().pop(),t=daysAgo(rows,0);
const week=sum(rows,'request_count',(r)=>r.day>=utcDay(6));
return h('article',{class:'card'},h('header',{},h('code',{text:n.name}),h('span',{class:'muted',text:last?'最近活动 '+ago(last):'近期无活动'})),
h('p',{text:n.keys.length?n.keys.length+' 个密钥（'+[rw?rw+' 读写':null,ro?ro+' 只读':null].filter(Boolean).join(' · ')+'）':'没有有效密钥'}),
h('p',{text:'本 UTC 日 '+num(sum(t,'request_count'))+' 次 · 写入 '+num(sum(t,'object_count',isWrite))+' 个 / '+bytes(sum(t,'upload_bytes'))+' · 近 7 天 '+num(week)+' 次'}),
objectsBlock(n.name));});
fill('namespaces',h('div',{class:'head'},h('h2',{text:'命名空间'}),scanButton()),scanSummary(),cards.length?h('div',{class:'cards'},cards):h('p',{class:'empty',text:'还没有应用密钥。'}));}

function confirmBox(text,label,action,onCancel){const cancel=h('button',{type:'button',class:'quiet',text:'取消',onclick:onCancel});
const box=h('div',{class:'confirm',role:'group',onkeydown:(e)=>{if(e.key==='Escape')cancel.click();}},h('span',{text}),
h('button',{type:'button',class:'danger',text:label,onclick:(e)=>perform(e.currentTarget,action)}),cancel);
queueMicrotask(()=>cancel.focus());return box;}
function renderConnection(){const box=byId('connection');box.hidden=false;const s=state.settings??{};const facts=[];
const fact=(k,v)=>facts.push(h('div',{},h('dt',{text:k}),h('dd',{},v)));
fact('状态',s.connected?mark('ok','已连接'):mark('unknown','未连接'));
fact('App key',s.app_key?h('code',{text:s.app_key}):'—');fact('应用文件夹','应用/Todofy Shared Storage');
if(s.connected){fact('连接时间',when(s.connect_time));fact('最近成功',when(s.last_success_time));}
const r=s.last_provider_error?reason(s.last_provider_error):null;
fact('最近错误',r?h('span',{},mark(r.tone,r.title),h('span',{class:'muted',text:' · '+when(s.last_provider_error_time)})):'无');
const reauthorize=state.space?.state==='scope_missing'?h('div',{class:'notice calm'},h('p',{},h('strong',{text:'显示 Dropbox 空间需要重新授权'})),
h('p',{text:'在 Dropbox App Console 打开这个应用的 Permissions，勾选 account_info.read 并提交；再在这里断开并重新连接。断开期间应用读写会失败，请选应用空闲的时候。文件和应用密钥不受影响。'})):null;
const actions=h('div',{class:'actions'});
if(s.connected){const ask=h('button',{type:'button',text:'断开连接',onclick:()=>{actions.replaceChildren(confirmBox('断开后，所有应用的读写都会立即失败，直到重新连接；Dropbox 中的文件保留。','确认断开',
async()=>{await api('dropbox:disconnect',{method:'POST',body:'{}'});await load();status('已断开连接，文件保留。');},()=>{actions.replaceChildren(ask);ask.focus();}));}});actions.append(ask);}
else{const input=h('input',{required:true,pattern:'[a-z0-9]{8,32}',autocomplete:'off',spellcheck:'false',value:s.app_key??''});
actions.append(h('form',{class:'connect',onsubmit:(e)=>{e.preventDefault();perform(e.submitter,async()=>{const result=await api('dropbox:connect',{method:'POST',body:JSON.stringify({app_key:input.value})});location.assign(result.authorize_url);});}},
h('label',{},'Dropbox App key',input),h('button',{class:'primary',text:'连接 Dropbox'})));}
fill('connection',h('div',{class:'head'},h('h2',{text:'Dropbox 连接'})),h('dl',{class:'facts'},facts),reauthorize,actions);}

function keyRow(k){const todayCount=sum(today(),'request_count',(r)=>r.client===k.name);
const revoke=h('button',{type:'button',class:'quiet',text:'撤销',onclick:()=>{if(row.querySelector('.confirm'))return;
row.append(confirmBox('撤销后，使用“'+k.label+'”的应用会立即收到 401；文件不受影响，此密钥无法恢复。','确认撤销',
async()=>{await api(k.name,{method:'DELETE'});await load();status('密钥“'+k.label+'”已撤销。');},(e)=>{e.currentTarget.parentElement.remove();revoke.focus();}));}});
const row=h('div',{class:'row'},h('div',{class:'name'},h('span',{text:k.label}),h('span',{class:'badge'+(k.access==='read_write'?' rw':''),text:k.access==='read_write'?'读写':'只读'})),revoke,
h('p',{class:'meta',text:['创建于 '+date(k.create_time),k.last_use_time?'最近使用 '+ago(k.last_use_time):'尚未使用','本 UTC 日 '+num(todayCount)+' 次'].join(' · ')}));return row;}
function createForm(){const names=h('datalist',{id:'namespace-options'},namespaces().map((n)=>h('option',{value:n.name})));
return h('form',{class:'create',onsubmit:(e)=>{e.preventDefault();const f=e.currentTarget;perform(e.submitter,async()=>{
const result=await api('clients?request_id='+crypto.randomUUID(),{method:'POST',body:JSON.stringify({label:f.label.value,namespace:f.namespace.value,access:f.access.value})});
issued=result.api_key??'';creating=false;await load();status('密钥已创建。');});}},
h('label',{},'名称',h('input',{name:'label',required:true,maxlength:80,placeholder:'例如：数据导出'})),
h('label',{},'命名空间',h('input',{name:'namespace',required:true,pattern:'[a-z][a-z0-9_\\-]{0,63}',placeholder:'小写字母开头，如 exports',list:'namespace-options',autocomplete:'off',spellcheck:'false'}),names),
h('label',{},'权限',h('div',{class:'seg',role:'radiogroup'},h('label',{},h('input',{type:'radio',name:'access',value:'read_only',checked:true}),h('span',{text:'只读'})),
h('label',{},h('input',{type:'radio',name:'access',value:'read_write'}),h('span',{text:'读取和条件写入'})))),h('button',{class:'primary',text:'创建'}));}
function renderKeys(){const groups=namespaces().filter((n)=>n.keys.length);
const parts=[h('div',{class:'head'},h('h2',{},'应用密钥',h('span',{class:'muted',text:clients().length+' / 64'})),
h('button',{type:'button',class:creating?'':'primary',text:creating?'取消':'新建密钥','aria-expanded':String(creating),onclick:()=>{creating=!creating;renderKeys();}}))];
if(issued){const copy=h('button',{type:'button',text:'复制',onclick:()=>{navigator.clipboard.writeText(issued).then(()=>{copy.textContent='已复制';},()=>{copy.textContent='复制失败，请手动选择';});}});
parts.push(h('div',{class:'issued',role:'status'},h('strong',{text:'新密钥只显示这一次'}),h('p',{class:'muted',text:'复制后交给调用方保存。离开或刷新页面后无法再次查看。'}),
h('div',{class:'secret'},h('code',{text:issued}),copy,h('button',{type:'button',class:'quiet',text:'完成',onclick:()=>{issued='';renderKeys();}}))));}
if(creating)parts.push(createForm());
if(!groups.length)parts.push(h('p',{class:'empty',text:'还没有应用密钥。'}));
for(const n of groups)parts.push(h('div',{class:'group'},h('h3',{},h('code',{text:n.name}),h('span',{text:n.keys.length+' 个密钥'})),
n.keys.slice().sort((a,b)=>a.label.localeCompare(b.label,'zh-CN')||a.create_time.localeCompare(b.create_time)).map(keyRow)));
fill('keys',parts);}

function renderActivity(){const label=(c)=>clients().find((k)=>k.name===c)?.label??'已撤销的密钥';
const items=(state.recent_failures??[]).map((f)=>{const r=reason(f.reason,f.http_status);return h('li',{},h('time',{datetime:f.failure_time,text:when(f.failure_time)}),
h('span',{class:'what'},mark(r.tone,r.title),h('span',{class:'who',text:label(f.client)+' · '+f.namespace+' · '+(OPS[f.operation]??f.operation)})),
h('span',{class:'detail',text:'HTTP '+f.http_status+(f.retry_after_seconds?' · 等待 '+f.retry_after_seconds+' 秒':'')}));});
fill('failures',h('div',{class:'head'},h('h2',{text:'最近异常'}),h('span',{class:'muted',text:'保留最近 50 条；同一密钥、操作和原因每分钟记一条，限流每个密钥每分钟一条'})),
items.length?h('ul',{class:'events'},items):h('p',{class:'empty',text:'近期没有异常。'}));
const cols=[['请求',(r)=>r.request_count],['限流',(r)=>r.outcome==='rate_limited'?r.request_count:0],['失败',(r)=>isFailed(r)?r.request_count:0],
['写入对象',(r)=>isWrite(r)?r.object_count:0],['上传',(r)=>r.upload_bytes,true],['下载',(r)=>r.download_bytes,true]];
const cells=(rows)=>cols.map((c)=>{const v=rows.reduce((t,r)=>t+Number(c[1](r)??0),0);return h('td',{class:v?'':'zero',text:c[2]?(v?bytes(v):'0'):num(v)});});
const table=(first,rows)=>h('div',{class:'table-scroll'},h('table',{},h('thead',{},h('tr',{},h('th',{text:first}),cols.map((c)=>h('th',{text:c[0]})))),h('tbody',{},rows)));
const daily=byId('daily');daily.hidden=false;
fill('daily',h('div',{class:'head'},h('h2',{text:'每日明细'}),h('span',{class:'muted',text:'UTC 日 · 所有命名空间'})),
table('日期',[...Array(14)].map((_,i)=>h('tr',{},h('td',{text:shortDay(utcDay(i))}),cells(daysAgo(usage(),i))))));
const t=today(),ops=Object.keys(OPS).filter((o)=>t.some((r)=>r.operation===o)),batches=t.filter((r)=>r.operation==='batch_create'&&r.outcome==='ok'),batchCount=sum(batches,'request_count');
const operations=byId('operations');operations.hidden=false;
fill('operations',h('div',{class:'head'},h('h2',{text:'本 UTC 日按操作'})),
ops.length?table('操作',ops.map((o)=>h('tr',{},h('td',{text:OPS[o]}),cells(t.filter((r)=>r.operation===o))))):h('p',{class:'empty',text:'本 UTC 日还没有应用请求。'}),
batchCount?h('p',{class:'note',text:'批量写入 '+num(batchCount)+' 次 · 平均 '+(sum(batches,'object_count')/batchCount).toFixed(1)+' 个对象/批 · 最大 '+Math.max(0,...batches.map((r)=>r.max_batch_object_count??0))+' 个（上限 32）'}):null,
h('p',{class:'note',text:'只统计带有效应用密钥的请求；在边缘被拒绝的格式错误密钥、本页面和健康检查不计入。不存在的对象和版本冲突属于正常回答，不算失败。'}),
h('p',{class:'note',text:'计数先在内存中累计，约 30 秒写入一次，打开本页时也会写入；部署或重启最多少计 30 秒。日期按 UTC 划分，与 Workers 免费额度的重置时间一致；其他时间按浏览器时区显示。'}));}

function renderFooter(){byId('footer').replaceChildren('版本 ',h('code',{text:state.build_sha||'本地开发'}),' · 状态库 '+bytes(state.state_size_bytes));}
function route(){const view=['overview','keys','activity'].includes(location.hash.slice(1))?location.hash.slice(1):'overview';
for(const el of document.querySelectorAll('[data-view]'))el.hidden=el.dataset.view!==view;
for(const a of document.querySelectorAll('.tabs a')){if(a.getAttribute('href')==='#'+view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
if(state&&view==='overview')renderTrend();}
function render(){renderSummary();renderTrend();renderNamespaces();renderConnection();renderKeys();renderActivity();renderFooter();byId('updated').textContent='更新于 '+clock(Date.now());}
async function load(){state=await api('overview');render();}
addEventListener('hashchange',route);addEventListener('resize',()=>{if(state&&!byId('trend').closest('[data-view]').hidden)renderTrend();});route();
byId('refresh').addEventListener('click',(e)=>perform(e.currentTarget,load));
load().catch((error)=>{fill('summary',h('p',{role:'alert',text:'无法读取状态：'+error.message}));});`;
