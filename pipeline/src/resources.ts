import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { execLogged, files, fileSha, write, inside } from './storage.js';

export async function checkApk(apk: string, log: string, maxBytes = 536870912) {
  if (path.extname(apk).toLowerCase() !== '.apk') throw new Error('Only standalone .apk inputs are supported');
  const script = `import sys,zipfile,json,pathlib
p=pathlib.Path(sys.argv[1]);limit=int(sys.argv[2])
with zipfile.ZipFile(p) as z:
 entries=z.infolist();names=[x.filename for x in entries]
 if len(entries)>100000 or sum(x.file_size for x in entries)>limit: raise ValueError('APK expansion limit exceeded')
 if len(set(names))!=len(names): raise ValueError('Duplicate ZIP entries')
 for n in names:
  if n.startswith('/') or '..' in pathlib.PurePosixPath(n).parts or '\\\\' in n: raise ValueError('Unsafe APK path')
 if 'AndroidManifest.xml' not in names or 'classes.dex' not in names: raise ValueError('Not a complete standalone APK')
 if any(n.endswith('.apk') for n in names): raise ValueError('Nested APK archive unsupported')
 bad=z.testzip()
 if bad: raise ValueError('Corrupt ZIP member: '+bad)
 print(json.dumps({'entries':len(entries),'expanded_bytes':sum(x.file_size for x in entries)}))`;
  return JSON.parse(await execLogged('python3', ['-c', script, apk, String(maxBytes)], log));
}
export async function extractResources(apk: string, root: string, cfg: any) {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'mvp-resources-'));
  const output = path.join(local, 'resources');
  await fs.mkdir(root, { recursive: true });
  await write(path.join(root, 'workspace.json'), { owned_temporary_workspace: local, destination: root });
  await checkApk(apk, path.join(root, 'apk-check.json'), cfg.max_expanded_bytes);
  const monitor = async () => {
    if (!(await fs.access(output).then(() => true, () => false))) return;
    let expanded = 0; const current = await files(output);
    if (current.length > 100000) throw new Error('Decoded resource file count limit exceeded');
    for (const p of current) { expanded += (await fs.stat(p)).size; if (expanded > cfg.max_expanded_bytes) throw new Error('Decoded resource expansion limit exceeded'); }
  };
  await execLogged(process.env.REA_APKTOOL_COMMAND || 'apktool', ['d', '--no-src', '-p', path.join(local, 'framework'), '-o', output, apk], path.join(root, 'extract-log.json'), cfg.resource_timeout_ms, 8 * 1024 * 1024, monitor);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, parseAttributeValue: false });
  const index: any[] = []; let size = 0;
  for (const p of await files(output)) {
    const st = await fs.stat(p); size += st.size;
    if (size > cfg.max_expanded_bytes) throw new Error('Decoded resource size exceeds limit');
    const rel = path.relative(output, p);
    if (!(rel === 'AndroidManifest.xml' || rel.startsWith('res/') || rel.startsWith('assets/'))) continue;
    const record: any = { path: path.join(root, 'resources', rel), relative: rel, bytes: st.size, sha256: await fileSha(p), qualifier: rel.startsWith('res/') ? rel.split('/')[1] : '', resource_keys: [] };
    if (p.endsWith('.xml') && st.size >= 8 * 1024 * 1024) record.limitation = 'XML exceeds parsing byte limit; metadata only';
    if (p.endsWith('.xml') && st.size < 8 * 1024 * 1024) {
      const text = await fs.readFile(p, 'utf8');
      if (text.includes('<!DOCTYPE') || text.includes('<!ENTITY')) { record.limitation = 'DTD/entity XML rejected'; }
      else if (XMLValidator.validate(text) !== true) record.limitation = 'Malformed XML';
      else {
        const parsed = parser.parse(text);
        record.xml = parsed;
        const walk = (v: any, pointer: string) => {
          if (!v || typeof v !== 'object') return;
          if (v['@name']) record.resource_keys.push({ key: v['@name'], pointer, value: v['#text'] ?? '' });
          for (const [k, x] of Object.entries(v)) walk(x, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`);
        };
        walk(parsed, '');
      }
    }
    index.push(record);
  }
  const snapshot = { source: 'apktool_local_snapshot', apk_sha256: await fileSha(apk), expanded_bytes: size, files: index };
  const copier = `import os,sys,shutil,concurrent.futures
src,dst=sys.argv[1:]
jobs=[]
for directory,dirs,names in os.walk(src):
 target=os.path.join(dst,os.path.relpath(directory,src));os.makedirs(target,exist_ok=True)
 for n in names:jobs.append((os.path.join(directory,n),os.path.join(target,n)))
with concurrent.futures.ThreadPoolExecutor(max_workers=128) as pool:list(pool.map(lambda pair:shutil.copyfile(*pair),jobs))
print(len(jobs))`;
  await execLogged('python3', ['-c', copier, output, path.join(root, 'resources')], path.join(root, 'snapshot-copy.json'), cfg.resource_timeout_ms);
  await write(path.join(root, 'resource-index.json'), snapshot);
  await fs.rm(local, { recursive: true, force: true });
  return snapshot;
}
export function resourceSummary(index: any) {
  return { source: index.source, files: index.files.length, layouts: index.files.filter((x: any) => x.relative.startsWith('res/layout')).map((x: any) => x.relative), default_strings: index.files.filter((x: any) => x.relative === 'res/values/strings.xml').map((x: any) => x.xml), manifest: index.files.find((x: any) => x.relative === 'AndroidManifest.xml')?.xml, limitation: 'Other qualifiers and assets are retained on disk and readable on demand. Missing layout XML does not establish missing pages.' };
}
export async function extractSmaliMethod(apk: string, className: string, methodName: string, run: string, dest: string, cfg: any) {
  if (!/^[\w.$]+$/.test(className)) throw new Error('Invalid disassembly class selector');
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'mvp-smali-')), output = path.join(local, 'decoded');
  await fs.mkdir(dest, { recursive: true });
  await write(path.join(dest, 'workspace.json'), { owned_temporary_workspace: local, class_name: className, method_name: methodName });
  await checkApk(apk, path.join(dest, 'apk-check.json'), cfg.max_expanded_bytes);
  const monitor = async () => {
    if (!(await fs.access(output).then(() => true, () => false))) return;
    const current = await files(output); let bytes = 0;
    if (current.length > 100000) throw new Error('Disassembly file count limit exceeded');
    for (const p of current) { bytes += (await fs.stat(p)).size; if (bytes > cfg.max_expanded_bytes) throw new Error('Disassembly expansion limit exceeded'); }
  };
  try {
    await execLogged(process.env.REA_APKTOOL_COMMAND || 'apktool', ['d','--no-res','-p',path.join(local,'framework'),'-o',output,apk], path.join(dest,'decode-log.json'),cfg.resource_timeout_ms,8*1024*1024,monitor);
    await monitor();
    const matches: string[] = [];
    for (const name of await fs.readdir(output)) if (/^smali(?:_classes\d+)?$/.test(name)) {
      const candidate = inside(output, path.join(output,name,className.replace(/\./g,'/')+'.smali'));
      if (await fs.access(candidate).then(()=>true,()=>false)) matches.push(candidate);
    }
    if (matches.length !== 1) throw new Error('Disassembly class selector is missing/ambiguous');
    if ((await fs.stat(matches[0])).size > 8*1024*1024) throw new Error('Disassembled class exceeds read limit');
    const source = await fs.readFile(matches[0],'utf8');
    const methods = [...source.matchAll(/^\.method[^\n]*\n[\s\S]*?^\.end method/gm)].map(x=>x[0]).filter(x=>x.split('\n')[0].includes(' '+methodName+'('));
    if (methods.length !== 1 || !/(?:^|\n)\s+(?:invoke-|return-|iget|iput|const-|if-|goto)/.test(methods[0])) throw new Error('Disassembly method is missing/ambiguous or has no instructions');
    const rawClass = path.join(dest,'class.smali'); await write(rawClass,source);
    const result = { source:'apktool_smali_method',apk_sha256:await fileSha(apk),class_name:className,method_name:methodName,raw_class_path:path.relative(run,rawClass),raw_class_sha256:await fileSha(rawClass),method_text:methods[0],limitations:['Static DEX disassembly; not original source lines or runtime execution.'] };
    await write(path.join(dest,'method.json'),result); return result;
  } finally { await fs.rm(local,{recursive:true,force:true}); }
}
