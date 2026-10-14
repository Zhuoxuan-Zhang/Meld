import path from 'node:path';
import { execLogged, write, files, fileSha } from '../src/storage.js';
const root=process.cwd(), run=path.resolve(process.argv[2]);
const dir=path.join(run,'validation',`program-${Date.now()}`);
const checks=await Promise.allSettled([
  execLogged('npm',['run','typecheck'],path.join(dir,'typecheck.json')),
  execLogged('npm',['test'],path.join(dir,'tests.json')),
  execLogged('npm',['run','build'],path.join(dir,'build.json')),
]);
const source_hashes:Record<string,string>={};
for(const d of ['src','scripts','config','prompts','tests']) for(const p of await files(path.join(root,d))) source_hashes[path.relative(root,p)]=await fileSha(p);
for(const name of ['package.json','package-lock.json','tsconfig.json']) source_hashes[name]=await fileSha(path.join(root,name));
const tests=checks[1].status==='fulfilled' ? checks[1].value : '';
const result={passed:checks.every(c=>c.status==='fulfilled'),checked_at:new Date().toISOString(),test_count:Number(tests.match(/Tests\s+(\d+) passed/)?.[1] || 0),commands:['npm run typecheck','npm test','npm run build'],logs:path.relative(run,dir),source_hashes,errors:checks.flatMap(c=>c.status==='rejected'?[String(c.reason)]:[]),scope:'Actual program checks; isolated test fixtures do not prove model or reference-app runtime behavior.'};
await write(path.join(run,'validation/program-checks.json'),result);
console.log(JSON.stringify({passed:result.passed,test_count:result.test_count,logs:result.logs,errors:result.errors}));
if(!result.passed) process.exitCode=1;
