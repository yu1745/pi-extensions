/**
 * Benchmark: web_reader_local vs web_reader vs web_reader_spa
 * Usage: node bench-all.mjs [urls...]
 * Output: JSON lines to stdout
 */
import { parseHTML } from 'linkedom';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 20000;

const BOILERPLATE_ROLES = new Set(['navigation','banner','contentinfo','complementary','search','alert','dialog']);
const BOILERPLATE_TAGS = new Set(['nav','footer','aside']);

const HIDDEN_TOKENS=new Set(['hidden','sidebar','cookie','modal','popup','offscreen']);
function isHidden(el) {
  const style=(el.getAttribute('style')||'').toLowerCase().replace(/\s/g,'');
  if(style.includes('display:none')||style.includes('visibility:hidden')||style.includes('opacity:0'))return true;
  for(const raw of [el.className, el.id]){
    const l=String(raw).toLowerCase();if(!l)continue;
    if(l.includes('sr-only')||l.includes('visually-hidden'))return true;
    for(const tok of l.split(/[^a-z0-9]+/)){ if(tok&&HIDDEN_TOKENS.has(tok))return true; }
  }
  return false;
}
const AD_TOKEN_SET=new Set(['ad','ads','advert','advertisement','advertising','sponsor','sponsored','promo','promos','newsletter']);
function isAd(el) {
  const sig=[el.className, el.id].join(' ').toLowerCase();
  const toks=sig.split(/[^a-z0-9]+/);
  if(toks.some(t=>AD_TOKEN_SET.has(t)))return true;
  return /share-buttons|social-share|related-posts/.test(sig);
}
const CONTENT_LEAF_SEL = 'p, pre, blockquote, h1, h2, h3, h4, h5, h6, li, figcaption';
const ROW_ITEM_TAGS = new Set(['A','LI','TR','DD','DT','DIV','ARTICLE','SECTION','P','SPAN']);
const CANDIDATE_TAGS = new Set(['div','section','article','main','body']);
function inBoilerplate(el) {
  for (let cur=el; cur; cur=cur.parentElement) {
    if (isHidden(cur)||isAd(cur)) return true;
    const tag = cur.tagName.toLowerCase();
    if (BOILERPLATE_TAGS.has(tag)) return true;
    const role = cur.getAttribute('role'); if (role && BOILERPLATE_ROLES.has(role)) return true;
    const sig = ((cur.className||'')+' '+(cur.id||'')).toLowerCase();
    if (/\b(sidebar|breadcrumb|site-header|site-footer|topbar|navbar|mega-menu|skip-link|cookie|consent|paywall|signup-modal)\b/.test(sig)) return true;
  }
  return false;
}
function linkDensityOf(el) {
  const text=(el.textContent||'').trim();
  if (!text.length) return 0;
  let lt=0; for (const a of el.querySelectorAll('a')) lt+=(a.textContent||'').trim().length;
  return lt/text.length;
}
function findMainContent(doc, rootOverride) {
  const body = rootOverride || doc.body || doc.querySelector('main') || doc.documentElement;
  // Phase 1: single-article shortcut
  const articles = [...doc.querySelectorAll('article')].filter(a=>!inBoilerplate(a));
  const bodyLen = (body?.textContent||'').trim().length;
  if (articles.length===1 && bodyLen>200) {
    const len=(articles[0].textContent||'').trim().length;
    if (len>=bodyLen*0.3 && linkDensityOf(articles[0])<0.5) return articles[0];
  }
  // Phase 2: leaf-accumulation
  const scores=new Map();
  for (const leaf of doc.querySelectorAll(CONTENT_LEAF_SEL)) {
    if (inBoilerplate(leaf)) continue;
    const text=(leaf.textContent||'').trim();
    if (text.length<40) continue;
    const commas=(text.match(/[,、。.;；]/g)||[]).length;
    let s=1+commas+Math.min(Math.floor(text.length/100),10);
    const isHeading=/^h[1-6]$/.test(leaf.tagName.toLowerCase());
    const ld=linkDensityOf(leaf);
    if (ld>0.8&&!isHeading) continue;
    if (ld>0.25&&!isHeading) s*=1-ld*0.9;
    let factor=1;
    for (let anc=leaf.parentElement; anc; anc=anc.parentElement) {
      scores.set(anc,(scores.get(anc)||0)+s*factor);
      factor*=0.7; if (factor<0.05) break;
    }
  }
  // Phase 2b: structural listing bonus
  for (const parent of doc.querySelectorAll('ul,ol,table,dl,div')) {
    if (inBoilerplate(parent)) continue;
    const kids=[...parent.children];
    if (kids.length<4) continue;
    const tags=new Set(kids.map(k=>k.tagName));
    if (tags.size!==1) continue;
    const t0=[...tags][0];
    if (!ROW_ITEM_TAGS.has(t0)) continue;
    let linked=0;
    for (const k of kids) {
      const a=k.matches?.('a')?k:k.querySelector('a');
      const len=((a&&a.textContent)||'').trim().length;
      if (len>=8&&len<=300) linked++;
    }
    if (linked<Math.max(4,Math.ceil(kids.length*0.6))) continue;
    const bonus=Math.min((linked*linked)/4+4,150);
    let bf=1;
    for (let anc=parent.parentElement; anc; anc=anc.parentElement) {
      scores.set(anc,(scores.get(anc)||0)+bonus*bf);
      bf*=0.7; if (bf<0.05) break;
    }
  }
  if (scores.size===0) return doc.querySelector('article')||body;
  // Phase 3: container priors
  const cands=[];
  for (const [el,raw] of scores) {
    const tag=el.tagName.toLowerCase();
    if (!CANDIDATE_TAGS.has(tag)) continue;
    let sc=raw;
    if (tag==='article') sc*=1.3; else if (tag==='main') sc*=1.15;
    const sig=((el.className||'')+' '+(el.id||'')).toLowerCase();
    if (/\b(article|post|entry|story|blog|prose|markdown|content)\b/.test(sig)) sc*=1.25;
    cands.push({el,score:sc});
  }
  if (!cands.length) return body;
  cands.sort((a,b)=>b.score-a.score);
  // Phase 4: trim outer husk
  let best=cands[0].el;
  for(;;){
    const own=scores.get(best)||0;
    let topKid=null, topScore=0;
    for (const kid of best.children){const s=scores.get(kid)||0;if(s>topScore){topScore=s;topKid=kid;}}
    if (!topKid||topScore<own*0.8) break;
    const t=topKid.tagName.toLowerCase();
    if (t==='tbody'||t==='tr'||t==='thead'||t==='td') break;
    best=topKid;
  }
  return best;
}
function cleanTree(root) {
  for (const sel of ['script','style','noscript','iframe','object','embed','svg','math','template','slot'])
    root.querySelectorAll(sel).forEach(el=>el.remove());
  root.querySelectorAll('nav,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="search"]').forEach(el=>el.remove());
  Array.from(root.querySelectorAll('*')).forEach(el=>{ if (isHidden(el)||isAd(el)) el.remove(); });
}
function resolveAllUrls(root, base) {
  root.querySelectorAll('a[href],img[src]').forEach(el=>{
    const attr = el.tagName==='A'?'href':'src';
    const href = el.getAttribute(attr);
    if (!href||href.startsWith('data:')||href.startsWith('blob:')) return;
    try { el.setAttribute(attr, new URL(href, base).href); } catch {}
  });
}

const BLOCK = new Set(['p','div','section','article','main','figure','figcaption','blockquote','ul','ol','li','table','thead','tbody','tfoot','tr','th','td','pre','hr','dl','dt','dd','details','summary','h1','h2','h3','h4','h5','h6','form','fieldset','address','hgroup','header','footer','aside','nav']);
function isInsideBlock(el) { let c=el; while(c){if(BLOCK.has(c.tagName.toLowerCase()))return true;c=c.parentElement;} return false; }
function esc(s) { return s.replace(/\\/g,'\\\\').replace(/\*/g,'\\*').replace(/_/g,'\\_'); }

function inlineText(el) {
  let r='';
  for (const ch of el.childNodes) {
    if (ch.nodeType===3) { const t=ch.textContent.trim(); if(t) r+=(isInsideBlock(el)?t+' ':esc(t)+' '); }
    else if (ch.nodeType===1) {
      const ce=ch;
      if(BLOCK.has(ce.tagName.toLowerCase())){const t=ce.textContent.trim();if(t)r+=t+' ';continue;}
      r+=toMd(ce);
    }
  }
  return r;
}
function toMd(el) {
  const tag=el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) { const t=inlineText(el).trim(); return t?'\n\n'+('#'.repeat(+tag[1]))+' '+t+'\n\n':''; }
  if (tag==='p') { const t=inlineText(el).trim(); return t?'\n'+t+'\n\n':''; }
  if (tag==='strong'||tag==='b') { const t=inlineText(el).trim(); return t?'**'+t+'**':''; }
  if (tag==='em'||tag==='i') { const t=inlineText(el).trim(); return t?'*'+t+'*':''; }
  if (tag==='code'&&el.parentElement?.tagName?.toLowerCase()!=='pre') { const t=(el.textContent||'').trim(); return t?'`'+t+'`':''; }
  if (tag==='pre') { const c=el.querySelector('code'); const raw=(c||el).textContent.trim(); let lang=''; if(c){const m=(c.className||'').match(/(?:language-|lang-|hljs\\s+)([\\w+#-]+)/);if(m)lang=m[1];} return '\n\n```'+lang+'\n'+raw+'\n```\n\n'; }
  if (tag==='a') { const t=inlineText(el).trim(); const h=el.getAttribute('href')||''; if(!t)return ''; if(!h||h.startsWith('#')||h.startsWith('javascript:'))return t; return '['+t+']('+h+')'; }
  if (tag==='img') { const alt=el.getAttribute('alt')||''; const src=el.getAttribute('src')||''; return src?'!['+alt+']('+src+')':''; }
  if (tag==='br') return '\n';
  if (tag==='hr') return '\n\n---\n\n';
  if (tag==='blockquote') { const i=childrenMd(el).trim(); return '\n\n'+i.split('\n').map(l=>'> '+l).join('\n')+'\n\n'; }
  if (tag==='ul'||tag==='ol') { const items=[]; let idx=1; for(const li of el.querySelectorAll(':scope>li')){const p=tag==='ol'?idx+++'. ':'- '; items.push('\n'+p+childrenMd(li).trim());} return items.join('')+'\n'; }
  if (tag==='li') return '\n- '+childrenMd(el).trim()+'\n';
  if (tag==='table') { const layout=el.querySelector('table')||el.querySelectorAll('ul,ol,dl,blockquote,pre,h1,h2,h3,h4,h5,h6').length>0; if(layout) return childrenMd(el); const tm=renderTable(el); return tm||childrenMd(el); }
  if (tag==='details') { const s=el.querySelector(':scope>summary'); const st=s?inlineText(s).trim():'Details'; const parts=[]; for(const c of el.children){if(c===s)continue;if(c.nodeType===1){const m=childrenMd(c).trim();if(m)parts.push(m);}} return '\n**<details>'+st+'</details>**\n'+parts.join('\n')+'\n'; }
  if (tag==='summary') return inlineText(el);
  if (tag==='dl') return childrenMd(el);
  if (tag==='dt') { const t=inlineText(el).trim(); return '\n**'+t+'**\n'; }
  if (tag==='dd') { return ': '+childrenMd(el).trim()+'\n\n'; }
  if (tag==='del') { const t=inlineText(el).trim(); return '~~'+t+'~~'; }
  if (tag==='ins') { const t=inlineText(el).trim(); return '<ins>'+t+'</ins>'; }
  return childrenMd(el);
}
function childrenMd(el) { const p=[]; for(const c of el.childNodes){if(c.nodeType===3){const t=c.textContent.trim();if(t)p.push(t+' ');}else if(c.nodeType===1){const m=toMd(c);if(m)p.push(m);}} return p.join(''); }
function renderTable(el) {
  const rows=[];
  const cellText=(c)=>childrenMd(c).trim().replace(/[ \t]*\n+[ \t]*/g,' ').replace(/\|/g,'\\|');
  for (const sec of ['thead','tbody','tfoot']) for (const tr of el.querySelectorAll(':scope>'+sec+' > tr')) rows.push(Array.from(tr.querySelectorAll(':scope>th,:scope>td')).map(cellText));
  if (!rows.length && el.querySelector(':scope>tr')) {
    for (const tr of el.querySelectorAll(':scope>tr')) {
      const cells=Array.from(tr.children).filter(c=>c.tagName==='TH'||c.tagName==='TD').map(cellText);
      if(cells.length) rows.push(cells);
    }
  }
  const nonEmpty = rows.filter(r=>r.some(c=>c.trim().length>0));
  if (!nonEmpty.length) return '';
  const maxC=Math.max(...rows.map(r=>r.length));
  const lines=[];
  for (let i=0;i<nonEmpty.length;i++){const r=nonEmpty[i];while(r.length<maxC)r.push('');lines.push('| '+r.join(' | ')+' |');if(i===0)lines.push('| '+r.map(()=>'---').join(' | ')+' |');}
  return '\n\n'+lines.join('\n')+'\n\n';
}

function ensureContentRoot(doc) {
  const body = doc.body;
  if (body && (body.textContent||'').trim().length>0) return body;
  const wrap = doc.createElement('main');
  while (doc.firstChild) wrap.appendChild(doc.firstChild);
  doc.appendChild(wrap);
  return wrap;
}

async function localReader(url) {
  const t0=Date.now();
  const r=await fetch(url,{headers:{'User-Agent':UA,'Accept':'text/html,application/xhtml+xml','Accept-Language':'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7','Accept-Encoding':'identity','Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate','Sec-Fetch-Site':'none'},redirect:'follow',signal:AbortSignal.timeout(TIMEOUT)});
  const html=await r.text();
  const {document:doc}=parseHTML(html);
  let title='';
  const tEl=doc.querySelector('title');
  if(tEl){const raw=(tEl.textContent||'').trim();title=raw.replace(/\s*[{(].*$/s,'').replace(/\s*<.*/,'').trim()||raw.split(/[({<]/)[0].trim();}
  const contentRoot = ensureContentRoot(doc);
  const main=findMainContent(doc, contentRoot);
  if (process.env.DBG) console.error('[sel]', main.tagName, String(main.className||'').slice(0,50), 'textlen', (main.textContent||'').trim().length);
  cleanTree(main);
  if (process.env.DBG) console.error('[clean]', main.tagName, 'textlen', (main.textContent||'').trim().length);
  resolveAllUrls(main,r.url);
  let md=toMd(main).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/ {2,}/g,' ').trim();
  if (process.env.DBG) console.error('[md]', md.length);
  if(title) md='Title: '+title+'\nURL: '+r.url+'\nHTTP: '+r.status+'\n\n'+md;
  return {md, time:Date.now()-t0, htmlLen:html.length, mdLen:md.length, status:r.status};
}

// === URLs ===
const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
  // --- Article / documentation pages (content extraction matters most) ---
  'https://en.wikipedia.org/wiki/JavaScript',
  'https://zh.wikipedia.org/wiki/JavaScript',
  'https://docs.python.org/3/tutorial/index.html',
  'https://doc.rust-lang.org/book/ch01-01-installation.html',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Functions',
  'https://go.dev/blog/slices-intro',
  'https://arxiv.org/abs/1706.03762',
  'http://info.cern.ch/hypertext/WWW/TheProject.html',   // first webpage ever, minimal HTML
  // --- Blog homepages ---
  'https://blog.rust-lang.org/',
  'https://www.ruanyifeng.com/blog/',
  'https://coolshell.cn/',
  'https://overreacted.io/',
  'https://danluu.com/',                                  // ultra-minimal HTML
  'https://hacks.mozilla.org/',
  // --- Tech news / listing ---
  'https://lwn.net/',
  'https://css-tricks.com/',
  'https://www.smashingmagazine.com/',
  'https://news.ycombinator.com',
  'https://www.v2ex.com',
  // --- Forum Q&A (SSR) ---
  'https://stackoverflow.com/questions/231767/what-does-the-yield-keyword-do-in-python',
  // --- Chinese platforms ---
  'https://sspai.com/',
  'https://juejin.cn/',                                   // SPA
  'https://www.zhihu.com/question/19551361',               // Q&A page
  'https://www.bilibili.com/',                             // anti-bot
  // --- npm package page (React SPA) ---
  'https://www.npmjs.com/package/linkedom',
];

const results = [];
for (const url of urls) {
  try {
    const r = await localReader(url);
    results.push({url, ...r, error:null});
    console.error('[OK] '+url+' '+r.time+'ms md='+r.mdLen);
  } catch(e) {
    results.push({url, md:'', time:0, htmlLen:0, mdLen:0, status:0, error:e.message});
    console.error('[ERR] '+url+' '+e.message);
  }
}
// Output JSON to stdout (unless NO_JSON=1)
if (!process.env.NO_JSON) console.log(JSON.stringify(results, null, 2));
