// The white-screen gate.
//
// Every unit test mounts a component in isolation; nothing asserts that the SHIPPED
// bundle boots. A bad dynamic import, a circular module, a CSP rule or a broken
// chunk split renders a blank page that the whole suite still calls green. This
// loads the real app in real Chromium and insists it mounted and stayed up.
import { expect, test, type ConsoleMessage } from "@playwright/test";

/** Console noise that is expected with no backend running. */
const BENIGN =
  /Failed to load resource|ERR_CONNECTION_REFUSED|net::ERR|127\.0\.0\.1:8000|Failed to fetch|NetworkError|sentry/i;

test.describe("app boot", () => {
  test("mounts something into #root and does not white-screen", async ({ page }) => {
    await page.goto("/");
    const root = page.locator("#root");
    await expect(root).toBeAttached();
    await expect
      .poll(async () => (await root.innerHTML()).trim().length, { timeout: 15_000 })
      .toBeGreaterThan(50);
  });

  test("throws no uncaught error or unhandled rejection while booting", async ({ page }) => {
    const fatal: string[] = [];
    page.on("pageerror", (e) => fatal.push(String(e)));
    page.on("console", (m: ConsoleMessage) => {
      if (m.type() === "error" && !BENIGN.test(m.text())) fatal.push(m.text());
    });

    await page.goto("/");
    await page.waitForTimeout(2500);

    expect(fatal, `the app logged fatal errors on boot:\n${fatal.join("\n")}`).toEqual([]);
  });

  test("renders the application chrome, not just an empty div", async ({ page }) => {
    await page.goto("/");
    // The menu bar is the one piece of shell that renders with no project and no
    // backend, so it is the honest "the UI is really up" signal.
    await expect(page.locator("#root button, #root [role='menu'], #root nav").first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("can use the tool catalogue without requesting it from a server", async ({ page }) => {
    const sent: string[] = [];
    page.on("request", (request) => {
      if (/\/contract\/tools\b/.test(request.url())) sent.push(request.url());
    });
    await page.route("**/contract/tools**", (route) => route.abort());
    await page.goto("/");
    const validation = await page.evaluate(async () => {
      const { validateToolArgs } = await import("/src/contract/params.ts");
      return {
        valid: validateToolArgs("export", { output_path: "preview.mp4" }),
        obsolete: validateToolArgs("export", { format: "mp4" }),
      };
    });
    expect(validation.valid).toEqual({ ok: true });
    expect(validation.obsolete.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  test("survives a hard reload (no boot-order dependence on a warm module cache)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#root")).toBeAttached();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect
      .poll(async () => (await page.locator("#root").innerHTML()).trim().length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(50);
  });
});
