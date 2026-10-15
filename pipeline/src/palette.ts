function colorRgb(value: string): number[] {
  if (!/^#[\da-f]{6}$/i.test(value)) throw new Error('Use a six-digit hexadecimal color');
  return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255);
}
export function contrast(a: string, b: string): number {
  const luminance = (value: string) => colorRgb(value).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((s, x, i) => s + x * [.2126, .7152, .0722][i], 0);
  const [x, y] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (x + .05) / (y + .05);
}
export function paletteErrors(tokens: { role: string; value: string }[]): string[] {
  const normalized = tokens.map(token => ({ name: token.role.split(/\s[—–]\s|:\s/)[0].toLowerCase().replace(/[^a-z]/g, ''), value: token.value }));
  const themes = ['light', 'dark'].filter(theme => normalized.some(token => token.name.startsWith(theme)));
  const errors: string[] = tokens.filter(token => !/^#[\da-f]{6}$/i.test(token.value)).map(token => `Invalid color ${token.role}: use only #RRGGBB in value; put descriptions in role`);
  for (const theme of themes.length ? themes : ['']) {
    const candidates = normalized.filter(token => theme ? token.name.startsWith(theme) : !/^(light|dark)/.test(token.name));
    const get = (pattern: RegExp, exclude?: RegExp) => candidates.find(token => pattern.test(token.name) && !(exclude?.test(token.name)))?.value;
    const palette: Record<string, string | undefined> = { primary: get(/primary|accent/, /onprimary|onaccent|textprimary|primarytext/), onPrimary: get(/onprimary|onaccent/), textPrimary: get(/textprimary|primarytext|(?:light|dark)text$/), background: get(/background$/), surface: get(/surface$/) };
    for (const [a, b] of [['primary', 'onPrimary'], ['textPrimary', 'background'], ['textPrimary', 'surface']]) {
      try { if (!palette[a] || !palette[b] || contrast(palette[a]!, palette[b]!) < 4.5) errors.push(`Insufficient contrast ${theme ? theme + ' ' : ''}${a}/${b}`); } catch (error) { errors.push(String(error)); }
    }
  }
  return errors;
}
