import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { projectServer, idea } from './project-fixtures';

test('only a delivered current app becomes a homepage example and opens without starting a new pipeline',async({page})=>{
 const api=await projectServer();
 try {
  let project=await api.service.create({requestKey:randomUUID(),brief:{...idea,name:'Focus Grove'},exampleId:'notes'});api.options.featuredProjectId=project.id;
  let status=await(await fetch(api.address+'/api/status')).json();expect(status.featuredProject).toBeNull();
  await api.service.build(project.id,{requestKey:randomUUID(),expectedVersion:project.version,revision:project.currentDesignRevision!});await api.service.idle();project=await api.service.get(project.id);
  status=await(await fetch(api.address+'/api/status')).json();expect(status.featuredProject.id).toBe(project.id);
  await page.route('**/api/**',async route=>{try{const request=route.request(),url=new URL(request.url()),response=await page.request.fetch(api.address+url.pathname+url.search,{method:request.method(),headers:{'Content-Type':'application/json',Origin:api.address},data:request.postData()||undefined});await route.fulfill({response});}catch(error){if(!/cancelled|closed|already handled/i.test(String(error)))throw error;}});
  await page.goto('/');await expect(page.getByLabel('Featured app example')).toBeVisible();await page.getByRole('button',{name:'Open app example',exact:true}).click();await expect(page.getByRole('heading',{name:'Your Android app is ready.'})).toBeVisible();expect(api.counts()).toEqual({analysisCalls:0,buildCalls:1});
  await api.service.mutate(project.id,p=>{p.needsDesign=true});expect((await(await fetch(api.address+'/api/status')).json()).featuredProject).toBeNull();
 }finally{await page.close();await page.unrouteAll({behavior:'ignoreErrors'}).catch(()=>undefined);await api.close();}
});
