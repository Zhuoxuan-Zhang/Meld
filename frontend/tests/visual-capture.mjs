import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome" });
await fs.mkdir("qa-screenshots", { recursive: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1050 },
  deviceScaleFactor: 1,
});
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto("http://127.0.0.1:4173");
await page.screenshot({
  path: "qa-screenshots/home-desktop.png",
  fullPage: true,
});
await page.getByRole("button", { name: /^Productivity/ }).click();
await page.getByRole("button", { name: /^Wellness/ }).click();
await page.getByRole("button", { name: "Explore apps" }).click();
await page.screenshot({
  path: "qa-screenshots/apps-desktop.png",
  fullPage: true,
});
await page.getByRole("button", { name: /Forest.*Find your focus/ }).click();
await page.getByRole("checkbox", { name: /Focus timer/ }).check();
await page.getByRole("checkbox", { name: /Your focus garden/ }).check();
await page.screenshot({
  path: "qa-screenshots/features-desktop.png",
  fullPage: true,
});
await page.getByRole("button", { name: "Save & return" }).click();
await page.getByRole("button", { name: "Continue", exact: true }).click();
await page.getByLabel("What will you call it?").fill("Little by Little");
await page
  .getByLabel("Who is it for?")
  .fill("People finding their everyday rhythm");
await page.screenshot({
  path: "qa-screenshots/review-desktop.png",
  fullPage: true,
});
await page.getByRole("button", { name: "Create my app" }).click();
await page.waitForURL("**/#/result");
await page.screenshot({
  path: "qa-screenshots/result-desktop.png",
  fullPage: true,
});
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({
  path: "qa-screenshots/result-mobile.png",
  fullPage: true,
});
await page.goto("http://127.0.0.1:4173/#/domains");
await page.screenshot({
  path: "qa-screenshots/home-mobile.png",
  fullPage: true,
});
await fs.writeFile(
  "qa-screenshots/visual-status.json",
  JSON.stringify({
    url: page.url(),
    overflow: await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  }),
);
for (const [route, name] of [
  ["/apps", "apps"],
  ["/apps/forest", "features"],
  ["/review", "review"],
]) {
  await page.goto("http://127.0.0.1:4173/#" + route);
  await page.screenshot({
    path: "qa-screenshots/" + name + "-mobile.png",
    fullPage: true,
  });
}
await browser.close();
