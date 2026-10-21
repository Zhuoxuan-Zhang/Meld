import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

export async function baseUiDesignSkill() {
  const parent = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const root = path.basename(parent) === 'dist' ? path.dirname(parent) : parent;
  const content = await fs.readFile(path.join(root, 'skills/base-ui-design/SKILL.md'), 'utf8');
  if (content.length > 16000 || !content.startsWith('---\n')) throw new Error('Invalid base UI design skill');
  return content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}
