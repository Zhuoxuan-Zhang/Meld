import path from 'node:path';
import { write, exists } from '../storage.js';
import { renderDesign } from '../render.js';
import { type RevisionDataT, type UserDocumentT, type RefT } from './schemas.js';
import { refIndex } from './validation.js';

export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const mdText = (value: string) => value.replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;').replace(/[\\`*_{}\[\]()#+.!|]/g, '\\$&');
export const refAnchor = (ref: RefT) => `${ref.kind}-${ref.id}`;
export const developerLink = (ref: RefT) => `developer.html#${encodeURIComponent(refAnchor(ref))}`;
const screenshotNames: Record<string, string> = { 'page-collection': 'collection.png', 'page-search': 'search.png', 'page-editor': 'editor.png', 'page-labels': 'labels.png' };
export const screenshotFor = (id: string) => screenshotNames[id] || null;

export async function renderDocuments(dir: string, doc: UserDocumentT, data: RevisionDataT, version: number, implemented: boolean) {
  await write(path.join(dir, 'developer-design.json'), data);
  await write(path.join(dir, 'final-design.json'), data.design);
  await write(path.join(dir, 'brief.json'), data.brief);
  await write(path.join(dir, 'decisions.json'), data.decisions);
  await write(path.join(dir, 'user-doc.json'), doc);
  await renderDesign(dir, data.design);
  const t = (zh: string, en: string) => doc.language === 'en' ? en : zh;
  const status = implemented ? t('设计与当前应用一致', 'Matches the recorded app design') : t('设计已更新；应用待更新', 'Design awaiting implementation');
  let md = `# ${mdText(doc.title)}\n\n${t('设计', 'Design')} v${version} · ${status}\n\n${mdText(doc.summary)}\n\n${t('适合：', 'For: ')}${mdText(doc.audience)}\n\n`;
  for (const card of doc.features) {
    md += `## ${mdText(card.title)}\n\n${mdText(card.summary)}\n\n`;
    for (const step of card.steps) md += `- ${mdText(step)}\n`;
    for (const example of card.examples) md += `\n${t('例如：', 'For example: ')}${mdText(example)}\n`;
    for (const caveat of card.caveats) md += `\n${t('需要知道：', 'Keep in mind: ')}${mdText(caveat)}\n`;
    md += `\n${card.refs.map(ref => `[${mdText(`${t('详细开发说明：', 'Developer details: ')}${ref.kind}/${ref.id}`)}](${developerLink(ref)})`).join(' · ')}\n\n`;
  }
  md += `## ${t('页面与外观', 'Pages and appearance')}\n\n${mdText(doc.appearance)}\n\n`;
  for (const screen of doc.screens) md += `- **${mdText(screen.title)}**${t('：', ': ')}${mdText(screen.purpose)}\n`;
  md += `\n## ${t('当前选择', 'Product choices')}\n\n`;
  for (const choice of doc.choices) md += `- **${mdText(choice.title)}**${t('：', ': ')}${mdText(choice.selected)}${t('。', '. ')}${mdText(choice.reason)}\n`;
  md += `\n## ${t('范围与限制', 'Scope and boundaries')}\n\n` + doc.boundaries.map(x => `- ${mdText(x)}`).join('\n') + `\n\n[${t('完整开发文档', 'Full developer document')}](design.md) · [${t('结构化开发设计', 'Structured developer design')}](final-design.json)\n`;
  await write(path.join(dir, 'user-doc.md'), md);
  const refLinks = (refs: RefT[]) => refs.map(ref => `<a href="${escapeHtml(developerLink(ref))}">${t('详细开发说明', 'Developer details')}</a>`).join(' · ');
  const cards = doc.features.map(card => `<section id="${escapeHtml(card.id)}"><h2>${escapeHtml(card.title)}</h2><p>${escapeHtml(card.summary)}</p><ul>${card.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>${card.examples.map(s => `<p class="muted">${t('例如：', 'For example: ')}${escapeHtml(s)}</p>`).join('')}${card.caveats.map(s => `<p class="notice">${escapeHtml(s)}</p>`).join('')}<details><summary>${t('查看开发依据', 'View developer references')}</summary>${refLinks(card.refs)}</details></section>`).join('');
  const screens = (await Promise.all(doc.screens.map(async screen => {
    const name = screenshotFor(screen.id);
    return `<article><h3>${escapeHtml(screen.title)}</h3><p>${escapeHtml(screen.purpose)}</p>${name && await exists(path.join(dir, `screenshot-${name}`)) ? `<img src="screenshot-${escapeHtml(name)}" alt="Current app: ${escapeHtml(screen.title)}">` : `<p>${t('页面说明；界面待实现', 'Page description; interface awaiting implementation')}</p>`}</article>`;
  }))).join('');
  await write(path.join(dir, 'user-doc.html'), `<!doctype html><html lang="${escapeHtml(doc.language)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(doc.title)}</title><style>body{margin:0;color:#202124;background:#f7f8fa;font:16px/1.7 system-ui,sans-serif}main{max-width:980px;margin:auto;padding:32px 20px}header,section{background:white;border:1px solid #e4e7ed;border-radius:16px;padding:24px;margin:16px 0}h1{font-size:30px}h2{font-size:22px}.muted{color:#5f6368}.notice{background:#eef3fb;padding:12px;border-radius:8px}a{color:#315da8}.screens{display:flex;flex-wrap:wrap;gap:24px}.screens article{flex:1;min-width:160px}.screens img{width:140px;max-height:310px;object-fit:contain}details{margin-top:16px}li{margin:8px 0}</style><main><header><p class="muted">${t('设计', 'Design')} v${version} · ${status}</p><h1>${escapeHtml(doc.title)}</h1><p>${escapeHtml(doc.summary)}</p><p class="muted">${t('适合：', 'For: ')}${escapeHtml(doc.audience)}</p></header>${cards}<section><h2>${t('页面与外观', 'Pages and appearance')}</h2><p>${escapeHtml(doc.appearance)}</p><p class="muted">${t('当前应用的界面截图。', 'Screenshots of the recorded app.')} ${implemented ? '' : t('新设计中的改动尚待实现。', 'Changes in this design await implementation.')}</p><div class="screens">${screens}</div></section><section><h2>${t('当前选择', 'Product choices')}</h2>${doc.choices.map(c => `<h3>${escapeHtml(c.title)}</h3><p>${escapeHtml(c.selected)} · ${escapeHtml(c.reason)}</p>${refLinks(c.refs)}`).join('')}</section><section><h2>${t('范围与限制', 'Scope and boundaries')}</h2><ul>${doc.boundaries.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul></section><p><a href="developer.html">${t('开发说明', 'Developer details')}</a> · <a href="design.md">${t('开发文档 Markdown', 'Developer document (Markdown)')}</a> · <a href="final-design.json">${t('开发设计 JSON', 'Developer design (JSON)')}</a></p></main></html>`);
  const indexed = [...refIndex(data)].map(([key, value]) => {
    const separator = key.indexOf(':'); const ref = { kind: key.slice(0, separator), id: key.slice(separator + 1) } as RefT;
    return `<section id="${escapeHtml(refAnchor(ref))}"><h2>${escapeHtml(key)}</h2><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></section>`;
  }).join('');
  await write(path.join(dir, 'developer.html'), `<!doctype html><html lang="${escapeHtml(doc.language)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t('详细开发设计', 'Detailed developer design')} v${version}</title><style>body{font:15px/1.6 system-ui;margin:32px;color:#202124}section{border-top:1px solid #ddd;padding:24px 0;scroll-margin-top:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f7f9;padding:16px}a{color:#315da8}</style><h1>${t('详细开发设计', 'Detailed developer design')} v${version}</h1><p>${status} · <a href="user-doc.html">${t('返回易读文档', 'Return to readable document')}</a></p><p><a href="final-design.json">${t('完整开发设计 JSON', 'Full developer design (JSON)')}</a> · <a href="developer-design.json">${t('含 Brief 与决策的完整版本', 'Full design with brief and decisions')}</a></p>${indexed}<section id="scope"><h2>Scope / Brief</h2><pre>${escapeHtml(JSON.stringify({ scope: data.design.scope, brief: data.brief }, null, 2))}</pre></section><section id="compose"><h2>Compose contracts</h2><pre>${escapeHtml(JSON.stringify(data.design.compose, null, 2))}</pre></section></html>`);
}
