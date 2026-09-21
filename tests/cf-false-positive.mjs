import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const piRequire = createRequire("/home/wangyu/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/index.js");
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { handleCloudflareChallenge } = await jiti.import("../extensions/web-reader/cloudflare.ts");
const { createJevClient } = await jiti.import("../extensions/shared/jev/client.ts");
const KEY = JSON.parse(readFileSync("/home/wangyu/.pi/agent/auth.json","utf8"))["typesafe-jev"].key;
let calls=0; const real=createJevClient({apiKey:KEY});
const jev={version:real.version, async evaluate(r,o){calls++; return real.evaluate(r,o);}};
const ARGS=["--disable-blink-features=AutomationControlled","--disable-features=IsolateOrigins,site-per-process,AutomationControlled","--disable-infobars","--disable-dev-shm-usage","--no-first-run","--no-default-browser-check"];
// Pages that MENTION cloudflare (false-positive bait) + real CF challenge (must still work)
const SITES=[
 {n:"CF blog (mentions Cloudflare heavily)",u:"https://blog.cloudflare.com/", expect:false},
 {n:"CF Turnstile docs",u:"https://developers.cloudflare.com/turnstile/", expect:false},
 {n:"Cloudflare homepage",u:"https://www.cloudflare.com/", expect:false},
 {n:"REAL challenge (linux.do)",u:"https://linux.do/t/topic/2770639/11", expect:true},
];
const b=await chromium.launch({headless:false,args:ARGS});
let fails=0;
for(const s of SITES){
  const before=calls; const t0=Date.now();
  const ctx=await b.newContext({locale:"zh-CN",viewport:{width:1920,height:1080},extraHTTPHeaders:{"Accept-Language":"zh-CN,zh;q=0.9,en;q=0.8"}});
  const p=await ctx.newPage();
  try{ await p.goto(s.u,{waitUntil:"domcontentloaded",timeout:30000}); }catch(e){}
  await p.waitForTimeout(1200);
  const out=await handleCloudflareChallenge({page:p,context:ctx,url:s.u,jev,log:()=>{}});
  const spent=calls-before;
  const title=(await p.title()).slice(0,42);
  const len=await p.evaluate(()=>document.body?.innerText?.length||0);
  let ok=true, note=[];
  if(s.expect){ if(!out.solved){ok=false;note.push(`expected solved, got solved=${out.solved} reason=${out.reason}`);} }
  else { if(out.detected){ok=false;note.push(`FALSE POSITIVE on non-CF page (state=${out.state})`);}
         if(spent>0){ok=false;note.push(`wasted ${spent} Jev call(s)`);} }
  if(!ok)fails++;
  console.log(`${ok?"PASS":"FAIL"}  ${s.n.padEnd(38)} ${String(Date.now()-t0).padStart(5)}ms jev=${spent} solved=${out.solved} len=${len} "${title}"`);
  for(const x of note) console.log(`        - ${x}`);
  await ctx.close();
}
await b.close();
console.log(`\n${SITES.length-fails}/${SITES.length} passed; total Jev calls=${calls}`);
process.exit(fails?1:0);
