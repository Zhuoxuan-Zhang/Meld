import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { BaseUiEvidence, baseUiImages, imageMediaType, validateBaseUiMapping } from '../src/base-ui.js';
import { fileSha } from '../src/storage.js';
import { Claude } from '../src/claude.js';
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/claude-cli.js', async original => ({ ...await original<typeof import('../src/claude-cli.js')>(), executeClaudeCli: mocks.execute }));
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'base-ui-')); mocks.execute.mockReset(); });
afterEach(async () => { await fs.rm(root,{recursive:true,force:true}); });
async function evidence() {
  const image = path.join(root,'screen.png'); await fs.writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/60AAAAASUVORK5CYII=','base64')); const digest = await fileSha(image);
  return BaseUiEvidence.parse({reference:{id:'base-ui-'+'a'.repeat(24),baseAppId:'com.example.base',title:'Original base',source:'store_screenshots',screenshots:[{id:'screen-1',url:'/api/reference',sha256:digest,label:'Editor'}],visual:{summary:'Canvas above a compact toolbar',navigation:'Back at top left',hierarchy:'Large canvas',typography:'Small tool labels',colors:'Dark chrome',spacing:'Compact controls',controls:'Bottom tools',screens:[{screenshotId:'screen-1',name:'Editor',layout:'Canvas above tools',preserve:['Bottom tool strip'],adapt:[]}],limitations:['Store image only']}},images:[{id:'screen-1',path:image,sha256:digest}]});
}
it('binds every analyzed screenshot and rejects unknown or omitted references',async()=>{
 const e=await evidence();expect(await baseUiImages(e)).toEqual([e.images[0].path]);
 expect(BaseUiEvidence.safeParse({...e,images:[]}).success).toBe(false);
 expect(BaseUiEvidence.safeParse({...e,reference:{...e.reference,visual:{...e.reference.visual,screens:[]}}}).success).toBe(false);
 await fs.appendFile(e.images[0].path,'changed');await expect(baseUiImages(e)).rejects.toThrow('changed');
});
it('distinguishes original image formats instead of labeling JPEG as PNG',()=>{
 expect(imageMediaType(Buffer.from([255,216,255,224]))).toBe('image/jpeg');
 expect(imageMediaType(Buffer.from('RIFFxxxxWEBP','ascii'))).toBe('image/webp');
 expect(()=>imageMediaType(Buffer.from('<html>not an image</html>'))).toThrow('Unsupported');
});
it('requires proposed screens to cite actual base screens or explicitly explain unseen UI',async()=>{
 const e=await evidence(),screens=[{id:'editor'},{id:'export'}];
 const mapping=[{screenId:'editor',referenceScreenIds:['screen-1'],preserved:['Bottom tool strip'],adaptations:['Add an offline Save action'],proposedReason:null},{screenId:'export',referenceScreenIds:[],preserved:[],adaptations:[],proposedReason:'Export is not visible in the reference'}];
 expect(validateBaseUiMapping(screens,mapping,e.reference)).toEqual([]);
 expect(validateBaseUiMapping(screens,mapping.slice(0,1),e.reference)).not.toEqual([]);
 expect(validateBaseUiMapping(screens,[{...mapping[0],referenceScreenIds:['invented']},mapping[1]],e.reference)).not.toEqual([]);
 expect(validateBaseUiMapping(screens,[mapping[0],{...mapping[1],proposedReason:null}],e.reference)).not.toEqual([]);
});
it('attaches the original screenshot to detailed design calls and refuses changed evidence before model calls',async()=>{
 const e=await evidence(),state={config:{provider:'claude_cli',model:'test-model',max_calls:5,max_output_tokens:12000},calls:[]};
 mocks.execute.mockResolvedValue({model:'test-model',execution:{code:0},turn_completed:true,errors:[],tool_activity:false,usage:{output_tokens:100},final_text:'{"ok":true}'});
 const model=new Claude(root,root,state);await model.ask('design-pages-0','Design pages',{brief:{market_signals:{base_ui:e}}},z.object({ok:z.boolean()}));
 expect(mocks.execute.mock.calls[0][1].images).toEqual([e.images[0].path]);expect(mocks.execute.mock.calls[0][1].system).toContain('visual foundation');
 await fs.appendFile(e.images[0].path,'changed');await expect(model.ask('design-contracts-0','Design',{brief:{market_signals:{base_ui:e}}},z.object({ok:z.boolean()}))).rejects.toThrow('changed');expect(mocks.execute).toHaveBeenCalledTimes(1);
});
