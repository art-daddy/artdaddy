// Global setup for the real-browser lane: load each page once before any spec runs. On a cold dev
// server the first navigation pays for transforming the whole module graph (measured at 90 s on a
// busy Windows machine: `load` fired at 90.6 s), and that cost landed on whichever spec happened
// to run first and timed it out. The web server is already up here: Playwright starts it first.
import { chromium, type FullConfig } from "@playwright/test";

export default async function warmup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL ?? "http://127.0.0.1:5199";
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const path of [
      "/",
      "/preview-probe.html",
      "/preview-probe-chroma.html",
      "/preview-probe-rotation.html",
    ])
      await page.goto(`${baseURL}${path}`, { waitUntil: "load", timeout: 300_000 });
  } finally {
    await browser.close();
  }
}
