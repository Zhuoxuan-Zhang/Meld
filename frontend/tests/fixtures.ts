import { test as base, expect } from "@playwright/test";

// UI tests run against the curated sample catalog unless a test routes the
// market endpoints itself (later routes take precedence). This keeps them
// independent of Google Play and of whether the scanner is installed.
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
      await use();
    },
    { auto: true },
  ],
});
export { expect };
