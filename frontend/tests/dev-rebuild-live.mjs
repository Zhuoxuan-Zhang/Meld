// Opt-in verification against a running development server. Rebuilds the local
// pipeline; external APIs are stubbed to avoid starting or recovering jobs.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const base=process.env.MELD_BASE_URL || 'http://127.0.0.1:4173';
const browser=await chromium.launch({executablePath:process.env.MELD_BROWSER_EXECUTABLE});
const errors=[],statuses=[];
try {
  const page=await browser.newPage();
  await page.route('**/api/**',route=>route.fulfill({json:route.request().url().endsWith('/api/projects')?{projects:[]}:{available:false}}));
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(new URL(response.url()).origin===base && response.status()>=400)errors.push(`${response.status()} ${response.url()}`)});
  await page.goto(base);await page.locator('h1').waitFor();
  const build=new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'pipeline/node_modules/typescript/bin/tsc'),'-p',path.join(root,'pipeline/tsconfig.json')],{cwd:root,stdio:'pipe'});
    let output='';child.stderr.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(`Pipeline compile failed (${code}): ${output}`)));
  });
  let finished=false;const completion=build.finally(()=>{finished=true});
  while(!finished){const response=await page.request.get(`${base}/src/main.tsx`);statuses.push(response.status());await new Promise(resolve=>setTimeout(resolve,500));}
  await completion;await page.reload();await page.locator('h1').waitFor();
  if(errors.length || statuses.some(status=>status!==200))throw Error(JSON.stringify({errors,statuses}));
  const report={passed:true,scope:'Actual Vite frontend stays available while TypeScript emits pipeline modules. External API calls are stubbed; no app generation is claimed.',requests:statuses.length,statuses,browserErrors:errors};
  if(process.env.MELD_REBUILD_REPORT)await writeFile(process.env.MELD_REBUILD_REPORT,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close()}
