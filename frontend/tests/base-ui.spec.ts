import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { BaseUiEvidence, ObservationPlan, fileSha, write, json, semanticHash } from '../../pipeline/dist/src/integration.js';
import { baseUiResolver, baseUiDirectory, downloadBaseScreenshot, trustedScreenshotUrl } from '../../backend/src/base-ui';
import { projectServer, idea } from './project-fixtures';
import type { Project, UserDocument } from '../../shared/contracts';
const document: UserDocument = { language:'en',title:'Pocket Notes',summary:'Capture notes offline',audience:'Personal notes',features:[{id:'write',title:'Write',summary:'Write and save',steps:['Write','Save'],examples:[],caveats:[],refs:[]}],screens:[{id:'home',title:'Home',purpose:'Find notes',refs:[]}],choices:[],appearance:'Follow the base: note list with a bottom create action.',boundaries:['Offline'] };
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/60AAAAASUVORK5CYII=','base64');
const action=(p:Project)=>({requestKey:randomUUID(),expectedVersion:p.version});
async function setup(api:Awaited<ReturnType<typeof projectServer>>) {
 const p=await api.service.create({requestKey:randomUUID(),brief:idea});await api.service.research(p.id,action(p));await api.service.idle();
 const researched=await api.service.raw(p.id),base=Object.values(researched.references).flatMap(s=>s.apps)[0];base.screenshots=['https://play-lh.googleusercontent.com/base-fixture'];
 await api.service.mutate(p.id,p=>{p.references=researched.references;p.featurePreferences.baseAppId=base.appId;});return {project:await api.service.raw(p.id),base};
}
async function cache(api:Awaited<ReturnType<typeof projectServer>>,p:Project) {
 const base=Object.values(p.references).flatMap(s=>s.apps).find(a=>a.appId===p.featurePreferences.baseAppId)!;
 const id='base-ui-'+semanticHash({appId:base.appId,source:'store_screenshots',urls:base.screenshots}).slice(0,24),dir=baseUiDirectory(api.options.directory,p.id,id);await mkdir(dir,{recursive:true});const image=path.join(dir,'screen-1.png');await writeFile(image,png);const sha=await fileSha(image);
 const evidence=BaseUiEvidence.parse({reference:{id,baseAppId:base.appId,title:base.title,source:'store_screenshots',screenshots:[{id:'screen-1',sha256:sha,url:`/api/projects/${p.id}/base-ui/${id}/screen-1`,label:'Base home'}],visual:{summary:'List above bottom action',navigation:'Bottom create',hierarchy:'Full-width list',typography:'Title above snippets',colors:'Light neutral surfaces',spacing:'Compact rows',controls:'Bottom create action',screens:[{screenshotId:'screen-1',name:'Home',layout:'Notes list',preserve:['Bottom create action'],adapt:[]}],limitations:['Store screenshot only']}},images:[{id:'screen-1',path:image,sha256:sha}]});await write(path.join(dir,'evidence.json'),evidence);return evidence;
}
test('base screenshots reject arbitrary hosts, cross-host redirects, HTML and oversized bodies',async()=>{
 expect(()=>trustedScreenshotUrl('http://127.0.0.1/secrets')).toThrow();expect(()=>trustedScreenshotUrl('https://play-lh.googleusercontent.com.evil.test/image')).toThrow();
 await expect(downloadBaseScreenshot('https://play-lh.googleusercontent.com/image',async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/secret'}}))).rejects.toThrow();
 await expect(downloadBaseScreenshot('https://play-lh.googleusercontent.com/image',async()=>new Response('<html>wrong</html>'))).rejects.toThrow('Unsupported');
 await expect(downloadBaseScreenshot('https://play-lh.googleusercontent.com/image',async()=>new Response(png,{headers:{'Content-Length':String(9*1024*1024)}}))).rejects.toThrow('8 MB');
 expect(await downloadBaseScreenshot('https://play-lh.googleusercontent.com/image',async()=>new Response(png))).toEqual(png);
});
test('cached base UI reaches the outline, user review, edits and detailed design with immutable images',async({page})=>{
 test.setTimeout(60000);let seen:any;
 const api=await projectServer({apks:false,highLevel:async(_p,_dir,_change,evidence)=>{seen=evidence;return {document:structuredClone(document),response:'Ready'};}});
 try {
  let {project}=await setup(api);const e=await cache(api,project);api.options.baseUi=baseUiResolver(api.options.directory);
  const started=Date.now();const first=await api.options.baseUi(project,async()=>{});expect(first).toEqual(e);expect(Date.now()-started).toBeLessThan(3000);
  await api.service.outline(project.id,action(project));await api.service.idle();project=await api.service.get(project.id);expect(seen).toEqual(e);expect(project.highLevelDesign?.baseUiReference).toEqual(e.reference);
  await page.route('**/api/**',async route=>{try{const req=route.request(),url=new URL(req.url()),response=await page.request.fetch(api.address+url.pathname+url.search,{method:req.method(),headers:{'Content-Type':'application/json',Origin:api.address},data:req.postData()||undefined});await route.fulfill({response});}catch(error){if(!/cancelled|closed|already handled/i.test(String(error)))throw error;}});
  await page.goto('/?project='+project.id);await expect(page.getByRole('region',{name:'Base app UI reference'})).toBeVisible();await expect(page.getByAltText('Base home')).toBeVisible();await expect(page.getByText('Google Play screenshots',{exact:false})).toBeVisible();
  const response=await fetch(api.address+e.reference.screenshots[0].url);expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('image/png');
  await api.service.patchOutline(project.id,{expectedVersion:project.version,baseRevision:project.highLevelDesign!.revision,document:{...document,appearance:'Blue accent with the same bottom create action'}});project=await api.service.get(project.id);expect(project.highLevelDesign?.baseUiReference?.id).toBe(e.reference.id);
  const runner=api.service.pipeline.options.runner!;let brief:any;api.service.pipeline.options.runner=async task=>{brief=await json(task.brief);return runner(task)};
  const job=await api.service.detail(project.id,{...action(project),revision:project.highLevelDesign!.revision});await api.service.idle();expect((await api.service.job(job.id)).status).toBe('succeeded');expect(brief.market_signals.base_ui).toEqual(e);
  await page.close();await appendFile(e.images[0].path,'changed');await expect(api.options.baseUi(project,async()=>{})).rejects.toThrow('changed');
 }finally{await page.close();await page.unrouteAll({behavior:'ignoreErrors'}).catch(()=>undefined);await api.close();}
});
test('missing original base screenshots stop outline generation instead of inventing a visual baseline',async()=>{
 let called=false;const api=await projectServer({apks:false,highLevel:async()=>{called=true;return {document,response:'Ready'}}});
 try{const {project}=await setup(api);await api.service.mutate(project.id,p=>{for(const scan of Object.values(p.references))for(const app of scan.apps)app.screenshots=[]});api.options.baseUi=baseUiResolver(api.options.directory);const job=await api.service.outline(project.id,action(project));await api.service.idle();expect((await api.service.job(job.id)).error?.code).toBe('base_ui_missing');expect(called).toBe(false);expect((await api.service.raw(project.id)).highLevelDesign).toBeUndefined();}finally{await api.close();}
});

test('a generated replacement capture cannot masquerade as the selected original base',async()=>{
 const api=await projectServer({apks:false});
 try {
  const {project,base}=await setup(api),dir=path.join(api.root,'wrong-original');await mkdir(dir);
  const plan=ObservationPlan.parse({packageName:'com.generated.replacement',apk:'/not-installed.apk',role:'reference',scenarios:[{id:'home',goal:'Home'}]});await write(path.join(dir,'plan.json'),plan);
  await write(path.join(dir,'manifest.json'),{version:1,packageName:plan.packageName,apkSha256:'0'.repeat(64),role:'reference',planSha256:createHash('sha256').update(JSON.stringify(plan)).digest('hex'),createdAt:new Date().toISOString(),scenarios:[{id:'home',goal:'Home',required:true,status:'unavailable',visibleText:[]}],artifacts:[{path:'plan.json',sha256:await fileSha(path.join(dir,'plan.json'))}],limitations:[],graphStatus:'unavailable',runtimeStatus:'unavailable'});
  const config=path.join(api.root,'ui.json');await write(config,{bases:{[base.appId]:{referenceDirectory:dir,serial:'emulator-test',scenarios:plan.scenarios,vision:{provider:'claude_cli',model:'fixture'}}}});
  await expect(baseUiResolver(api.options.directory,config)(project,async()=>{})).rejects.toMatchObject({code:'base_ui_identity'});
 }finally{await api.close();}
});

test('editing an existing foundation remains possible when current discovery marks it complex',async()=>{
 const api=await projectServer({apks:false});
 try {
  const {project,base}=await setup(api);await api.service.mutate(project.id,p=>{for(const scan of Object.values(p.references))for(const app of scan.apps)if(app.appId===base.appId){app.title='Complex Social Video Network';app.description='Live streaming multiplayer messaging cloud account subscription marketplace social video';}});
  const p=await api.service.raw(project.id),updated=await api.service.patch(p.id,{expectedVersion:p.version,featurePreferences:{...p.featurePreferences,customRequests:[{id:'custom-ui',name:'Follow original UI',description:'Use the base screen layout'}]}});
  expect(updated.featurePreferences.baseAppId).toBe(base.appId);expect(updated.featurePreferences.customRequests[0].name).toBe('Follow original UI');
 }finally{await api.close();}
});
