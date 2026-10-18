import path from 'node:path';
import { z } from 'zod';
import { InvestigationClient } from './investigation-client.js';
import { execLogged, fileSha, write, redact } from './storage.js';

export const NativeProbe = z.object({
  path: z.string().regex(/^lib\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.+-]+\.so$/),
  provider: z.string().regex(/^[a-z][a-z0-9-]*$/).default('ghidra'),
  addresses: z.array(z.string().regex(/^0x[0-9a-fA-F]+$/)).max(5).default([]),
}).strict();

export async function inspectNativeLibraries(client: InvestigationClient, apk: string, directory: string, graph: any, probes: z.infer<typeof NativeProbe>[] = []) {
  const libraries: { path: string; sha256: string }[] = graph?.components?.native_libraries || [];
  const results = [];
  for (const probe of probes) {
    const library = libraries.find(item => item.path === probe.path);
    if (!library) throw new Error(`Native probe is outside authenticated APK inventory: ${probe.path}`);
    const output = path.join(directory, 'native', probe.path);
    try {
      // Read exactly one inventoried ELF member, with a bounded expansion.
      const script = `import zipfile,sys,pathlib
with zipfile.ZipFile(sys.argv[1]) as z:
 matches=[i for i in z.infolist() if i.filename==sys.argv[2]]
 if len(matches)!=1 or matches[0].file_size>64*1024*1024: raise ValueError('Invalid native library member')
 data=z.read(matches[0])
 if not data.startswith(b'\\x7fELF'): raise ValueError('Native member is not ELF')
 p=pathlib.Path(sys.argv[3]);p.parent.mkdir(parents=True,exist_ok=True)
 with p.open('xb') as f:f.write(data)
`;
      await execLogged('python3', ['-c', script, apk, probe.path, output], output + '.extract.json', 30000);
      if (await fileSha(output) !== library.sha256) throw new Error('Extracted native library differs from authenticated inventory');
      let layout: any, layoutError: string | undefined;
      try { layout = await client.call('inspect_binary_layout', { path: output }); } catch (error) { layoutError = redact(String(error)); }
      await client.call('open_binary', { path: output, provider_id: probe.provider });
      const overview = await client.call('binary_overview');
      const decompilation = probe.addresses.length ? await client.call('batch_decompile', { addresses: probe.addresses }) : null;
      results.push({ path: probe.path, sha256: library.sha256, status: 'observed', layout, layoutError, overview, decompilation, limitation: 'Static native analysis of selected functions; JNI wiring and runtime semantics remain unverified.' });
    } catch (error) { results.push({ path: probe.path, sha256: library.sha256, status: 'unavailable', error: redact(String(error)) }); }
  }
  const report = { inventory: libraries, probes: results, unexamined: libraries.filter(library => !probes.some(probe => probe.path === library.path)).map(library => library.path), limitations: ['DEX/native path pairs are bridge hypotheses, not verified JNI bindings. A provider failure or unexamined library never establishes native behavior.'] };
  await write(path.join(directory, 'native-analysis.json'), report);
  return report;
}
