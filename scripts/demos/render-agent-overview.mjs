// Render the README's illustrated workflow. Requires frontend Playwright and Python Pillow.
// Run with Node 24: node scripts/demos/render-agent-overview.mjs
import { chromium } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'outputs/readme-animation');
await mkdir(out, { recursive: true });
const screenshot = (await readFile(path.join(root, 'docs/images/pocket-ledger-preview.png'))).toString('base64');
const ink = '#243b33', muted = '#63786d', accent = '#b94f37';
const text = (x, y, content, size = 20, color = ink, weight = 400) => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}">${content}</text>`;
const box = (x, y, w, h, fill = '#ffffff', stroke = '#dce5d9', r = 18) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
const pill = (x, y, label, width = 130) => box(x, y, width, 30, '#e7eee1', 'none', 15) + text(x + 14, y + 20, label, 12, '#46644b', 700);
const scenes = [
  {
    label: 'START WITH A NEED', title: ['“Can I afford this', 'without going', 'over budget?”'],
    description: ['Describe the experience you want.', 'Meld turns it into a product brief.'],
    art: box(610, 234, 420, 240) + pill(636, 260, 'YOUR IDEA', 110) + text(636, 325, 'A calmer budget app.', 26, ink, 700) + text(636, 365, 'Keep daily spending simple.', 20, muted) + text(636, 402, 'Let me try a purchase first.', 20, muted) + text(636, 443, 'One clear goal. A useful starting point.', 15, accent),
  },
  {
    label: 'BUILD ON WHAT WORKS', title: ['One base.', 'A few good ideas.'],
    description: ['Keep the base app’s visual foundation.', 'Choose references and add your own request.'],
    art: box(610, 222, 420, 86, '#edf3e8') + text(634, 252, 'BASE · CASHEW', 12, '#46644b', 700) + text(634, 285, 'Cards, budgets, transaction flow', 21, ink, 700) + box(610, 321, 420, 86) + text(634, 351, 'REFERENCES · MONEY MANAGER + WALLET', 11, muted, 700) + text(634, 384, 'Calendar + clear budget breakdowns', 20, ink, 700) + box(610, 420, 420, 86, '#fbede4') + text(634, 450, 'YOUR REQUEST', 12, accent, 700) + text(634, 483, 'Try a purchase before recording it', 20, ink, 700),
  },
  {
    label: 'THE AGENT PROPOSES', title: ['Turn the pieces', 'into a better', 'way to decide.'],
    description: ['Meld connects the selected ideas', 'into a focused product proposal.'],
    art: box(610, 222, 420, 284) + pill(634, 244, 'PROPOSED WORKFLOW', 192) + text(634, 312, '01   Enter a possible purchase', 21, ink, 700) + text(634, 360, '02   Compare its budget impact', 21, ink, 700) + text(634, 408, '03   Cancel or record it once', 21, ink, 700) + text(634, 468, 'Nothing is saved until you confirm.', 17, accent),
  },
  {
    label: 'YOU SHAPE THE RESULT', title: ['Review it.', 'Make it yours.', 'Then approve.'],
    description: ['Edit the proposal and design before building.', 'Your approved version guides the app.'],
    art: box(610, 222, 420, 284) + pill(634, 244, 'DESIGN REVIEW', 145) + text(634, 312, 'Keep the familiar budget overview', 20, ink, 700) + text(634, 348, 'Add a separate purchase preview', 20, ink, 700) + text(634, 384, 'Show before and after balances', 20, ink, 700) + box(634, 420, 372, 58, '#2f5942', 'none', 12) + text(708, 456, 'Approve &amp; build', 21, '#ffffff', 700),
  },
  {
    label: 'AN APP YOU CAN TRY', title: ['From proposal', 'to Pocket Ledger.'],
    description: ['Download the Android APK.', 'Try the same build in the browser.', 'Inspect the build and verification reports.'],
    art: box(714, 204, 208, 342, '#223c31', 'none', 26) + `<image href="data:image/png;base64,${screenshot}" x="722" y="212" width="192" height="326" preserveAspectRatio="xMidYMid meet"/>` + pill(646, 490, 'ACTUAL GENERATED APP', 206),
  },
];
function render(scene, index) {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="620" viewBox="0 0 1100 620"><rect width="1100" height="620" rx="24" fill="#ffffff"/><g font-family="Arial, Helvetica, sans-serif">`;
  s += text(44, 57, 'meld<tspan fill="#b94f37">.</tspan>', 32, ink, 700);
  s += text(726, 52, 'YOUR APP PROPOSAL AGENT', 13, muted, 700);
  ['Idea', 'References', 'Proposal', 'Design', 'Working app'].forEach((label, i) => {
    const x = 44 + i * 205;
    s += box(x, 84, 192, 48, i === index ? '#2f5942' : '#ffffff', i === index ? '#2f5942' : '#dce5d9', 12);
    s += text(x + 16, 114, `${i + 1}  ${label}`, 17, i === index ? '#ffffff' : muted, i === index ? 700 : 400);
  });
  s += text(44, 210, scene.label, 13, accent, 700);
  scene.title.forEach((line, i) => { s += text(42, 268 + i * 53, line, 44, ink, 700); });
  const y = 268 + scene.title.length * 53 + 12;
  scene.description.forEach((line, i) => { s += text(44, y + i * 28, line, 18, muted); });
  s += scene.art;
  s += `<path d="M44 565h1012" stroke="#dce5d9"/>`;
  s += text(44, 594, 'A familiar foundation. A proposal shaped around you.', 15, muted);
  s += text(800, 594, index === 4 ? 'Real APK capture' : 'Pocket Ledger · workflow illustration', 12, muted);
  return s + '</g></svg>';
}
const browser = await chromium.launch({
  executablePath: process.env.MELD_BROWSER_EXECUTABLE,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 620 }, deviceScaleFactor: 1 });
  for (let i = 0; i < scenes.length; i++) {
    const svg = render(scenes[i], i);
    await writeFile(path.join(out, `scene-${i}.svg`), svg);
    await page.setContent(`<style>body { margin: 0; }</style>${svg}`);
    await page.evaluate(() => Promise.all([...document.images].map(img => img.decode())));
    await page.screenshot({ path: path.join(out, `scene-${i}.png`) });
  }
} finally {
  await browser.close();
}
execFileSync('python', ['-c', `
from PIL import Image
from pathlib import Path
root=Path(${JSON.stringify(root)})
source=root/'outputs/readme-animation'
scenes=[Image.open(source/f'scene-{i}.png').convert('RGB') for i in range(5)]
# Short dissolves preserve reading time; the final real-app scene pauses longer.
frames=[]
durations=[]
for i,scene in enumerate(scenes):
 frames.append(scene)
 durations.append(3600 if i==4 else 3000)
 for alpha in [.2,.4,.6,.8]:
  frames.append(Image.blend(scene,scenes[(i+1)%5],alpha))
  durations.append(60)
# Use a shared palette to keep colors stable during transitions.
strip=Image.new('RGB',(1100,620*5))
for i,scene in enumerate(scenes): strip.paste(scene,(0,i*620))
palette=strip.quantize(colors=128)
frames=[frame.quantize(palette=palette,dither=Image.Dither.NONE) for frame in frames]
# Pin the canvas color after quantization so GIF palette averaging cannot tint it.
for frame in frames:
 colors=frame.getpalette()
 white=frame.getpixel((550,155))
 colors[white*3:white*3+3]=[255,255,255]
 frame.putpalette(colors)
output=root/'docs/images/meld-agent.gif'
frames[0].save(output,save_all=True,append_images=frames[1:],duration=durations,loop=0,optimize=True,disposal=1)
with Image.open(output) as im:
 assert im.n_frames==25 and im.info['loop']==0
 print(f'{output.name}: {im.n_frames} frames, {output.stat().st_size:,} bytes, {sum(durations)/1000:.1f}s loop')
`], { stdio: 'inherit' });
