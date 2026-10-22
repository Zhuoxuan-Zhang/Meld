import { test, expect } from '@playwright/test';

test('comparison gallery serves playable evidence-backed videos and both saved project links', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { featuredProjects: [
    { id: 'project-282843ad-103f-4458-9a40-d192b65be2ba', name: 'Focus Grove' },
    { id: 'project-a92b60ad-6e5a-445d-94f4-4b0f5d2c6064', name: 'Pocket Ledger' },
  ] } }));
  await page.goto('/demos/index.html');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A familiar foundation.');
  await expect(page.locator('video')).toHaveCount(2);
  for (const title of ['Focus Grove', 'Pocket Ledger']) {
    const article = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    const video = article.locator('video');
    await video.evaluate((element: HTMLVideoElement) => element.load());
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
    expect(await video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(30);
    await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(.4);
    await video.evaluate((element: HTMLVideoElement) => element.pause());
    await expect(article.getByRole('link', { name: `Open ${title}`, exact: true })).toHaveAttribute('href', /\?project=project-/);
    expect(await video.locator('track').getAttribute('kind')).toBe('captions');
    const captions = await page.request.get('/demos/' + await video.locator('track').getAttribute('src'));
    expect((await captions.text()).startsWith('WEBVTT')).toBe(true);
  }
  const provenance = await (await page.request.get('/demos/provenance.json')).json();
  expect(provenance.videos).toHaveLength(2);
  for (const video of provenance.videos) {
    expect(video.apkSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(video.scenes.some((scene: { kind: string }) => scene.kind === 'addition')).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
