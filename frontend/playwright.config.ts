import { defineConfig } from "@playwright/test";
const port = process.env.MELD_TEST_PORT || "4173";
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  workers: 3,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    channel: process.env.MELD_BROWSER_EXECUTABLE || process.env.MELD_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
    launchOptions: process.env.MELD_BROWSER_EXECUTABLE ? { executablePath: process.env.MELD_BROWSER_EXECUTABLE } : {},
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.MELD_TEST_PORT,
    timeout: 90000,
  },
});
