import { test, expect } from '@playwright/test';
import path from 'node:path';
import { cp, mkdtemp, rm, appendFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadCodingSkills, pinCodingSkills } from '../../backend/src/coding-skills';
import { pipelineRoot, json, write, semanticHash, baseUiDesignSkill } from '../../pipeline/dist/src/integration.js';

async function fixture() { const root = await mkdtemp(path.join(tmpdir(),'meld-coding-skills-')); const skills=path.join(root,'skills');await cp(path.join(pipelineRoot,'../backend/skills'),skills,{recursive:true});return{root,skills}; }
test('coding skill snapshots contain exactly the three native profiles and preserve the fixed toolchain',async()=>{
 const snapshot=await loadCodingSkills();expect(snapshot.manifest.skills.map(s=>s.id)).toEqual(['edge-to-edge','adaptive','jetpack-compose-performance']);expect(snapshot.manifest.stage).toBe('coding');expect(snapshot.manifest.toolchain).toEqual({compileSdk:35,composeBom:'2025.05.01',navigation3:false});expect(snapshot.manifest.upstream.commit).toHaveLength(40);expect(snapshot.fingerprint).toBe(semanticHash(snapshot.manifest));
});
test('changed or redirected coding rules are rejected before generation',async()=>{
 const f=await fixture();try{await appendFile(path.join(f.skills,'adaptive.md'),'changed');await expect(loadCodingSkills(f.skills)).rejects.toMatchObject({code:'coding_skill_changed'});await cp(path.join(pipelineRoot,'../backend/skills/adaptive.md'),path.join(f.skills,'adaptive.md'));await unlink(path.join(f.skills,'adaptive.md'));await symlink(path.join(pipelineRoot,'../backend/skills/adaptive.md'),path.join(f.skills,'adaptive.md'));await expect(loadCodingSkills(f.skills)).rejects.toMatchObject({code:'coding_skill_changed'});}finally{await rm(f.root,{recursive:true,force:true});}
});
test('a resumed build cannot silently switch coding profiles',async()=>{
 const f=await fixture();try{const snapshot=await loadCodingSkills(f.skills),build=path.join(f.root,'build');await pinCodingSkills(build,snapshot);await expect(pinCodingSkills(build,snapshot)).resolves.toMatchObject({fingerprint:snapshot.fingerprint});const record=await json(path.join(build,'coding-skills.json'));await write(path.join(build,'coding-skills.json'),{...record,fingerprint:'0'.repeat(64)});await expect(pinCodingSkills(build,snapshot)).rejects.toMatchObject({code:'coding_skill_changed'});}finally{await rm(f.root,{recursive:true,force:true});}
});
test('base UI design instructions load separately from the coding registry',async()=>{
 const design=await baseUiDesignSkill(),coding=await loadCodingSkills();expect(design).toContain('reference screenshot');expect(design).not.toContain('composeBom');expect(coding.manifest.skills.some(s=>(s.id as string)==='base-ui-design')).toBe(false);
});
