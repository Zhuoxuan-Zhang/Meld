import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  workers: 3,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.MELD_TEST_URL || "http://127.0.0.1:4173",
    channel: process.env.MELD_BROWSER_EXECUTABLE || process.env.MELD_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
    launchOptions: process.env.MELD_BROWSER_EXECUTABLE ? { executablePath: process.env.MELD_BROWSER_EXECUTABLE } : {},
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: process.env.MELD_TEST_URL || "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 90000,
  },
});
