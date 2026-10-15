import { write, sha } from './storage.js';
import path from 'node:path';
const esc = (x: unknown) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function section(name: string, x: any) {
  return `## ${name}\n\n${typeof x === 'string' ? x : '```json\n' + JSON.stringify(x, null, 2) + '\n```'}\n\n`;
}
export async function renderSpec(p: string, spec: any) {
  let md = `# ${spec.package_name} — Static Feature Specification\n\nVersion: ${spec.version}. APK SHA-256: ${spec.apk_sha256}\n\nstatic_only=true; runtime_verified=false; status=${spec.status}\n\n${spec.scope}\n\n`;
  for (const f of spec.features) {
    md += `## ${f.title} (${f.id})\n\nTask: ${f.task}\n\n`;
    for (const c of f.claims) md += `- **${c.classification}**: ${c.statement} (${c.id}; evidence: ${c.evidence_ids.join(', ') || 'none'}). ${c.limitations.join('; ')}\n`;
    md += '\n';
  }
  for (const [name, obj] of [['Pages', spec.pages], ['Flows', spec.flows], ['Data structures', spec.data_structures], ['Unknowns', spec.unknowns], ['Coverage', spec.coverage]]) md += section(name as string, obj);
  await write(p, md);
}
export async function renderDesign(dir: string, d: any) {
  const digest = sha(JSON.stringify(d));
  let md = `# ${d.title}\n\n**Proposed design** — ${d.status}. Derived from final-design.json (${digest}). Reference app runtime behavior was not verified.\n\n`;
  for (const [name, value] of Object.entries(d)) if (!['title', 'status'].includes(name)) md += section(name.replace(/_/g, ' '), value);
  await write(path.join(dir, 'design.md'), md);
  const notesContext = d.entities.some((entity: any) => /^note$/i.test(entity.name) || entity.id === "entity-note");
  const component = (c: any) => {
    const t = c.type.toLowerCase(); const text = esc(c.text);
    if (t.includes('textfield') || t.includes('input') || t.includes('editor')) return `<div class="field ${t.includes('editor') || /body|content/i.test(c.id) ? 'body' : ''}">${text || (t.includes('search') ? (notesContext ? 'Search notes' : 'Search') : 'Enter a value…')}</div>`;
    if (t.includes('button') || t.includes('action')) return `<div class="button" aria-label="${text}">${text}</div>`;
    if (t.includes('topbar') || t.includes('toolbar')) return `<div class="toolbar">${text}</div>`;
    if (t.includes('list') || t.includes('card')) return `<div class="note"><strong>${text || (notesContext ? 'Your notes' : 'Items')}</strong><div class="line"></div><div class="line short"></div></div>`;
    if (t.includes('navigation')) return `<div class="nav">${text}</div>`;
    return text ? `<div class="label">${text}</div>` : '';
  };
  const cards = d.pages.flatMap((p: any) => {
    const shell=p.states.find((s:any)=>s.id.endsWith('-shell'));
    return p.states.filter((s:any)=>s!==shell).flatMap((s:any)=>{
      const contexts=p.id==='page-collection'&&s.id!=='collection-no-results'||p.id==='page-editor'&&['editor-normal','editor-empty'].includes(s.id)?['Notes','Deleted']:p.id==='page-editor'&&['editor-delete-confirmation','editor-review-error'].includes(s.id)?['Deleted']:[notesContext ? 'Notes' : ''];
      return contexts.map(collection=>{
        const deleted=collection==='Deleted',ids=new Set([...(shell?.component_ids||[]),...s.component_ids]);
        const review=s.id.includes('review-'),initial=s.id==='editor-blocking';
        const sample=(value:string)=>value.replace(/\{([^}]+)\}/g,(_,key:string)=>{
          if(key==='Notes or Deleted')return collection;
          if(key==='Modified or Deleted')return deleted?'Deleted':'Modified';
          if(key==='message'||key==='dialog message')return '';
          if(key==='count')return '1';if(key==='date')return 'Today';
          if(/selected name/.test(key))return 'All labels';if(/label name|names or No labels|label names/.test(key))return 'Personal';
          if(key==='body')return 'Plan a walk in the park.';
          if(/preview/.test(key))return 'Plan a walk and prepare for next week.';
          if(/title|displayTitle/i.test(key))return s.kind==='empty'?'Untitled':'Weekend plans';
          return '';
        });
        const stateMessage=s.id==='collection-empty'?s.message.split(' / ')[deleted?1:0]||s.message:s.id==='editor-normal'?(deleted?'Deleted note — restore to edit.':'Saved'):s.id==='editor-empty'?'Write a note when you are ready.':s.message;
        const visible=p.components.filter((c:any)=>{
          if(!ids.has(c.id))return false;
          if(deleted&&(/NOTES only/.test(c.type)||['editor-delete'].includes(c.id)))return false;
          if(!deleted&&['editor-restore','editor-forever'].includes(c.id))return false;
          if((review||initial)&&['editor-fields','editor-title','editor-body','editor-labels','editor-delete','editor-restore','editor-forever'].includes(c.id))return false;
          if(s.id==='editor-review-error'&&c.id==='editor-leave')return false;
          if(p.id==='page-search'&&s.kind==='empty'&&c.id==='search-clear')return false;
          return true;
        }).map((c:any)=>({...c,text:sample(c.text).replace('New note / Retry new note','New note').replace('Add label / Update name','Add label'),type:deleted&&c.id==='editor-labels'?'Text':c.type}));
        return `<article data-page="${esc(p.id)}" data-state="${esc(s.kind)}" data-state-id="${esc(s.id)}" data-collection="${collection}"><h2>${esc(p.title)} <small>${esc(s.kind)}${collection ? ' · ' + collection : ''}</small></h2><div class="phone"><div class="status">9:41 <span>● ▰</span></div><div class="screen">${visible.map(component).join('')}${stateMessage?`<div class="message">${esc(sample(stateMessage))}</div>`:''}</div></div><p class="caption">${esc(s.condition)} · Illustrative ${collection ? collection + ' ' : ''}state; sample content.</p></article>`;
      });
    });
  }).join('');
  const colors = Object.fromEntries(d.visual.colors.map((c: any) => [c.role.toLowerCase(), c.value]));
  const lightColor = (pattern: RegExp) => d.visual.colors.find((c: any) => /light/i.test(c.role) && pattern.test(c.role))?.value;
  colors.primary ||= d.visual.colors.find((c: any) => /light/i.test(c.role) && /primary|accent/i.test(c.role) && !/on[-_ ]?primary/i.test(c.role))?.value;
  colors.primary ||= d.visual.colors.find((c: any) => /primary|accent/i.test(c.role) && !/on[-_ ]?primary/i.test(c.role))?.value;
  colors.background ||= lightColor(/background/i);
  colors.surface ||= lightColor(/surface/i);
  colors.on_surface ||= lightColor(/^light text$|on[-_ ]?surface/i);
  colors.on_surface ||= colors.onsurface;
  const safeColor = (v: any, fallback: string) => /^#[a-f\d]{3,8}$/i.test(v ?? '') ? v : fallback;
  await write(path.join(dir, 'wireframes.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.title)} — Proposed design</title><style>
:root{--accent:${safeColor(colors.primary, '#385e57')};--surface:${safeColor(colors.surface, '#f8faf9')};--ink:${safeColor(colors.on_surface, '#1d2926')}}*{box-sizing:border-box}body{margin:0;background:#e9eeeb;color:var(--ink);font:16px/1.5 system-ui,sans-serif}header{padding:28px 40px;background:white;border-bottom:1px solid #c6d0ca}h1{margin:0;font-size:28px}.badge{color:var(--accent);font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:28px;padding:28px}article{min-width:0}h2{font-size:18px;margin:0 0 14px}h2 small{display:block;font-size:13px;color:#52665a;font-weight:400}.phone{width:320px;min-height:568px;border:2px solid #83978d;border-radius:24px;background:var(--surface);overflow:hidden}.status{padding:10px 20px;font-size:12px}.status span{float:right}.screen{padding:0 18px 24px;overflow-wrap:anywhere}.toolbar{padding:16px 0;border-bottom:1px solid #d4ddd7;font-size:20px;font-weight:600}.field{margin:14px 0;padding:14px;border:1px solid #9aada2;border-radius:10px;min-height:48px;color:#53635a}.field.body{min-height:230px}.button{display:inline-block;background:var(--accent);color:white;padding:10px 16px;margin:12px 8px 12px 0;border-radius:10px}.note{padding:16px;margin:14px 0;background:white;border:1px solid #c6d0ca;border-radius:10px}.line{height:7px;margin-top:12px;width:90%;background:#e0e7e2}.line.short{width:65%}.label{padding:8px 0}.nav{padding:14px 0;border-top:1px solid #c6d0ca}.message{background:white;border:1px dashed #9aada2;padding:18px;margin:16px 0;border-radius:10px}.caption{font-size:13px;max-width:320px;color:#52665a}@media(max-width:400px){.grid{padding:14px;display:block}.phone{width:100%}header{padding:20px}article{margin-bottom:28px}}
</style><style>body{overflow-wrap:anywhere}.button{min-height:48px;min-width:48px}</style></head><body><header><div class="badge">Proposed design · Static wireframes</div><h1>${esc(d.title)}</h1><p>${esc(d.scope.target_users)}</p></header><main class="grid">${cards}</main><footer style="padding:24px">Source: final-design.json · ${digest}</footer></body></html>`);
  await write(path.join(dir, 'render-manifest.json'), { final_design_sha256: digest, pages: d.pages.map((p: any) => ({ id: p.id, states: p.states.map((s: any) => s.kind) })), renderer: 'src/render.ts', limitation: 'Low fidelity proposed screens; not reference app screenshots or an interactive app.' });
}
