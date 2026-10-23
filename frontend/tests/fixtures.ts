import { test as base, expect } from "@playwright/test";

// External scans and model summaries are disabled unless a test supplies real-
// shaped responses. Missing providers must never produce preset app cards.
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
export const test = base.extend<{ offlineMarket: void }>({
  offlineMarket: [
    async ({ page }, use) => {
      await page.route("**/api/market/**", (route) =>
        route.request().url().endsWith("/api/market/status")
          ? route.fulfill({
              json: { available: false, reason: "Disabled for this test." },
            })
          : route.fulfill({
              status: 503,
              json: { error: "Market signals are not set up." },
            }),
      );
      await page.route("**/api/claude/**", (route) =>
        route.request().url().endsWith("/api/claude/status")
          ? route.fulfill({
              json: { available: false, reason: "Disabled for this test." },
            })
          : route.fulfill({
              status: 503,
              json: { error: "Claude Code is not available." },
            }),
      );
      await page.route("**/api/account/status", route => route.fulfill({ json: { enabled: false } }));
      await page.route("**/api/projects", route => route.fulfill({ json: { projects: [] } }));
      await page.route("**/api/status", route => route.fulfill({ json: { available: false } }));
      await page.route("**/api/design/status", route => route.fulfill({ json: { available: false, exampleId: null, referenceFilesConfigured: false } }));
      await page.route("https://play-lh.googleusercontent.com/**", (route) =>
        route.fulfill({ contentType: "image/png", body: pixel }),
      );
      await use();
    },
    { auto: true },
  ],
});
export { expect };
