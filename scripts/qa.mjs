/**
 * Supplemental QA checks beyond scripts/e2e.mjs
 * Usage: APP_URL=http://localhost:3000 node scripts/qa.mjs
 */
import { chromium, devices } from "playwright-core";

const BASE = process.env.APP_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
    "--disable-gpu",
  ],
});

let passed = 0;
let failed = 0;
const ok = (n) => {
  passed += 1;
  console.log(`  PASS  ${n}`);
};
const fail = (n, m) => {
  failed += 1;
  console.error(`  FAIL  ${n}${m ? ` — ${m}` : ""}`);
};

try {
  // Invalid room
  console.log("invalid room");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/room/BAD`);
    const text = await page.locator("h1").innerText();
    if (/not found/i.test(text)) ok("invalid room shows not-found");
    else fail("invalid room shows not-found", text);
    await page.goto(`${BASE}/room/ab`);
    const text2 = await page.locator("h1").innerText();
    if (/not found/i.test(text2)) ok("too-short room id shows not-found");
    else fail("too-short room id shows not-found", text2);
    await ctx.close();
  }

  // Permission denial (camera + mic)
  console.log("permission denial");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const deny = () =>
        Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = deny;
        navigator.mediaDevices.enumerateDevices = async () => [];
      }
    });
    await page.goto(`${BASE}/room/abcdefghij`);
    await page.getByTestId("prejoin").waitFor();
    await page.waitForTimeout(1500);
    const bodyText = await page.locator("form").innerText();
    if (/camera|microphone|permission|unavailable|blocked/i.test(bodyText)) {
      ok("permission denial shows a camera/mic notice");
    } else {
      fail("permission denial shows a camera/mic notice", bodyText.slice(0, 120));
    }
    await page.getByTestId("join-name").fill("NoCam");
    await page.getByTestId("join").click();
    const joined = await page
      .getByTestId("ctl-leave")
      .waitFor({ state: "visible", timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (joined) ok("can join when camera/mic permission denied");
    else fail("can join when camera/mic permission denied");
    await page.getByTestId("ctl-leave").click().catch(() => undefined);
    await ctx.close();
  }

  // Refresh while in room
  console.log("refresh");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/room/refreshqa12`);
    await page.getByTestId("join-name").fill("Refresh");
    await page.getByTestId("join").click();
    await page.getByTestId("ctl-leave").waitFor({ timeout: 30000 });
    await page.reload();
    await page.getByTestId("prejoin").waitFor({ timeout: 15000 });
    ok("refresh returns to pre-join (clean disconnect)");
    await page.getByTestId("join-name").fill("Refresh");
    await page.getByTestId("join").click();
    await page.getByTestId("ctl-leave").waitFor({ timeout: 30000 });
    ok("can rejoin after refresh");
    await ctx.close();
  }

  // Copy link
  console.log("copy link");
  {
    const ctx = await browser.newContext();
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/room/copylinkqa1`);
    await page.getByTestId("join-name").fill("Copy");
    await page.getByTestId("join").click();
    await page.getByTestId("ctl-leave").waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: /copy link/i }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    if (clip.includes("/room/copylinkqa1")) ok("copy link writes room URL");
    else fail("copy link writes room URL", clip);
    await ctx.close();
  }

  // Mobile layout
  console.log("mobile layout");
  {
    const iPhone = devices["iPhone 13"];
    const ctx = await browser.newContext({
      ...iPhone,
      permissions: ["camera", "microphone"],
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/room/mobileqa123`);
    await page.getByTestId("prejoin").waitFor();
    const prejoinBox = await page.getByTestId("prejoin").boundingBox();
    if (prejoinBox && prejoinBox.width <= iPhone.viewport.width + 2) {
      ok("pre-join fits mobile viewport width");
    } else fail("pre-join fits mobile viewport width");
    await page.getByTestId("join-name").fill("Mobile");
    await page.getByTestId("join").click();
    await page.getByTestId("ctl-leave").waitFor({ timeout: 30000 });
    const bar = await page.locator(".control-bar").boundingBox();
    const leave = await page.getByTestId("ctl-leave").boundingBox();
    if (bar && leave && leave.height >= 44) ok("control bar tap targets are large");
    else fail("control bar tap targets are large");
    // People chip visible on mobile
    const people = await page.getByTestId("ctl-participants").isVisible();
    if (people) ok("mobile shows participants control");
    else fail("mobile shows participants control");
    await ctx.close();
  }

  // Landscape mobile
  console.log("landscape");
  {
    const ctx = await browser.newContext({
      viewport: { width: 844, height: 390 },
      isMobile: true,
      hasTouch: true,
      permissions: ["camera", "microphone"],
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/room/landscapqa1`);
    await page.getByTestId("join-name").fill("Land");
    await page.getByTestId("join").click();
    await page.getByTestId("ctl-leave").waitFor({ timeout: 30000 });
    const shell = await page.locator(".room-shell").boundingBox();
    if (shell && shell.height <= 390 + 2) ok("landscape room shell fits viewport height");
    else fail("landscape room shell fits viewport height");
    await ctx.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
} catch (error) {
  console.error("\nQA error:", error?.message ?? error);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
} finally {
  await browser.close();
}
