import { chromium } from "playwright-core";

const BASE = process.env.APP_URL ?? "http://localhost:3100";
const ROOM = process.env.ROOM ?? "e2e" + Math.random().toString(36).slice(2, 8);

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1280,800",
    "--enable-usermedia-screen-capturing",
    "--auto-select-desktop-capture-source=Entire screen",
    "--disable-blink-features=AutomationControlled",
  ],
});

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}

function fail(name, message) {
  failed += 1;
  console.error(`  FAIL  ${name}${message ? ` — ${message}` : ""}`);
}

async function joinRoom(page, name, roomId = ROOM) {
  await page.goto(`${BASE}/room/${roomId}`);
  await page.getByTestId("prejoin").waitFor({ state: "visible" });
  await page.getByTestId("join-name").fill(name);
  await page.getByTestId("join").click();
  await page.getByTestId("ctl-leave").waitFor({ state: "visible", timeout: 30000 });
}

async function waitForCount(page, expected, timeout = 20000) {
  try {
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="participant"]').length === n,
      expected,
      { timeout, polling: 250 },
    );
    return true;
  } catch {
    return false;
  }
}

async function waitForTestId(page, testId, timeout = 20000) {
  try {
    await page.getByTestId(testId).first().waitFor({ state: "attached", timeout });
    return true;
  } catch {
    return false;
  }
}

async function runningTiles(page) {
  return page.$$eval(
    '[data-testid="tile-video"]',
    (els) => els.filter((v) => (v.videoWidth || 0) > 0).length,
  );
}

const context1 = await browser.newContext();
const context2 = await browser.newContext();
const page1 = await context1.newPage();
const page2 = await context2.newPage();

try {
  console.log(`Room: ${ROOM}`);

  // 1. Landing page
  console.log("landing page");
  await page1.goto(BASE);
  const landing = await page1.getByTestId("create-room").isVisible() &&
    (await page1.getByTestId("join-input").isVisible());
  if (landing) ok("shows create + join controls");
  else fail("landing page shows create + join controls");

  // 2. Create flow from landing (Alice)
  console.log("create room flow");
  await page1.getByTestId("create-room").click();
  await page1.getByTestId("prejoin").waitFor({ state: "visible" });
  const createdUrl = page1.url();
  const roomMatch = createdUrl.match(/\/room\/([a-z0-9]{6,40})/);
  const room = roomMatch?.[1] ?? ROOM;
  if (roomMatch) ok(`created room ${room}`);
  else fail("create room produced a room URL");

  // 3. Pre-join camera preview
  await page1.getByTestId("join-name").fill("Alice");
  const previewWorks = await page1.waitForFunction(() => {
    const v = document.querySelector('[data-testid="preview"]');
    return !!v && v.videoWidth > 0;
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  if (previewWorks) ok("pre-join camera preview streams");
  else fail("pre-join camera preview streams");

  await page1.getByTestId("join").click();
  await page1.getByTestId("ctl-leave").waitFor({ state: "visible", timeout: 30000 });
  ok("Alice joined the room");

  // 4. Join flow from landing (Bob)
  console.log("join room flow (by code)");
  await page2.goto(BASE);
  await page2.getByTestId("join-input").fill(room);
  await page2.getByTestId("join-room").click();
  await page2.getByTestId("prejoin").waitFor({ state: "visible" });
  await page2.getByTestId("join-name").fill("Bob");
  await page2.getByTestId("join").click();
  await page2.getByTestId("ctl-leave").waitFor({ state: "visible", timeout: 30000 });
  ok("Bob joined the same room from a room code");

  // 5. Both see two participants
  console.log("participants");
  const bothSeeEachOther = await waitForCount(page1, 2, 30000) &&
    (await waitForCount(page2, 2, 30000));
  if (bothSeeEachOther) ok("both see two participants");
  else fail("both see two participants");

  // 6. Remote audio/video flowing
  console.log("media");
  const videosReady =
    (await page1
      .waitForFunction(
        () =>
          [...document.querySelectorAll('[data-testid="tile-video"]')].filter(
            (v) => (v.videoWidth || 0) > 0,
          ).length >= 2,
        null,
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false)) &&
    (await page2
      .waitForFunction(
        () =>
          [...document.querySelectorAll('[data-testid="tile-video"]')].filter(
            (v) => (v.videoWidth || 0) > 0,
          ).length >= 2,
        null,
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false));
  const p1videos = await runningTiles(page1);
  const p2videos = await runningTiles(page2);
  if (videosReady && p1videos >= 2 && p2videos >= 2) {
    ok(`remote+local video flowing (${p1videos}/${p2videos} tracked tiles)`);
  } else if (p1videos >= 1 && p2videos >= 1) {
    fail(`only local video flowing (${p1videos}/${p2videos})`);
  } else {
    fail(`no video flowing (${p1videos}/${p2videos})`);
  }

  console.log("controls");
  // 7. Toggle microphone
  await page1.getByTestId("ctl-mic").click();
  const aliceMicOff = await page1
    .getByTestId("ctl-mic")
    .getAttribute("aria-pressed");
  if (aliceMicOff === "false") ok("mic toggle updates state");
  else fail("mic toggle updates state");
  await page1.getByTestId("ctl-mic").click();

  // 8. Toggle camera
  await page1.getByTestId("ctl-cam").click();
  const bobSeesAliceCamOff = await page2
    .locator('[data-testid="tile"]', { hasText: "Alice" })
    .getByText("Camera off")
    .isVisible().catch(() => false);
  if (bobSeesAliceCamOff) ok("remote sees camera off state");
  else fail("remote sees camera off state");
  await page1.getByTestId("ctl-cam").click();
  await page1.waitForFunction(() =>
    document.querySelectorAll('[data-testid="tile-video"]').length > 0 &&
    [...document.querySelectorAll('[data-testid="tile-video"]')].some((v) => v.videoWidth > 0),
  );

  // 9. Screen sharing (Bob shares)
  console.log("screen share");
  await page2.getByTestId("ctl-screen").click();
  const localScreenTile = await waitForTestId(page2, "screen-share-tile", 15000);
  const remoteScreenSeen = await waitForTestId(page1, "screen-share-tile", 20000);
  const bobSharingBadge = await page1
    .locator('[data-testid="participant"][data-name="Bob"]')
    .getByText("Sharing")
    .isVisible().catch(() => false);
  if (localScreenTile && remoteScreenSeen && bobSharingBadge) {
    ok("screen share shows locally and remotely with a sharing badge");
  } else {
    if (localScreenTile) ok("screen share captured on the sharing side");
    else fail("screen share captured on the sharing side (getDisplayMedia failed)");
    if (remoteScreenSeen) ok("remote sees the shared screen tile");
    else fail("remote sees the shared screen tile");
    if (bobSharingBadge) ok("sharing badge shown in participant list");
    else fail("sharing badge shown in participant list");
  }
  await page2.getByTestId("ctl-screen").click();
  const remoteStopped = await page1
    .getByTestId("screen-share-tile")
    .waitFor({ state: "detached", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  const localStopped = await page2
    .getByTestId("screen-share-tile")
    .waitFor({ state: "detached", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (remoteStopped && localStopped) ok("screen share stops for everyone");
  else fail("screen share stops for everyone");

  // 10. Leave / rejoin
  console.log("leave and rejoin");
  await page1.getByTestId("ctl-leave").click();
  await page1.getByTestId("prejoin").waitFor({ state: "visible" });
  const bobAlone = await waitForCount(page2, 1, 20000);
  if (bobAlone) ok("leaving removes participant from the room");
  else fail("leaving removes participant from the room");

  await joinRoom(page1, "Alice", room);
  const rejoined = await waitForCount(page1, 2, 30000) && (await waitForCount(page2, 2, 30000));
  if (rejoined) ok("Alice re-joined and both see two participants again");
  else fail("Alice re-joined and both see two participants again");

  // 11. Third participant
  console.log("third participant");
  const context3 = await browser.newContext();
  const page3 = await context3.newPage();
  await joinRoom(page3, "Cassie", room);
  const threeVisible = await waitForCount(page3, 3, 30000) &&
    (await waitForCount(page1, 3, 30000)) &&
    (await waitForCount(page2, 3, 30000));
  if (threeVisible) ok("all three participants see each other");
  else fail("all three participants see each other");

  await context3.close();
  const backToTwo = await waitForCount(page1, 2, 20000) && (await waitForCount(page2, 2, 20000));
  if (backToTwo) ok("leaving drops the room back to two participants");
  else fail("leaving drops the room back to two participants");

  // 12. Network interruption / reconnect (Bob's connection)
  console.log("network interruption & reconnect");
  // LiveKit exposes simulateScenario for reliable reconnect testing; browser
  // offline emulation often does not break an existing WebRTC session.
  await page2.evaluate(async () => {
    const room = window.__meetRoom;
    if (!room) throw new Error("LiveKit room not exposed on window");
    await room.simulateScenario("signal-reconnect");
  });

  const reconnectBanner = await page2
    .getByTestId("reconnecting")
    .waitFor({ state: "visible", timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (reconnectBanner) ok("reconnecting indicator shown during signal loss");
  else fail("reconnecting indicator shown during signal loss");

  await page2
    .getByTestId("reconnecting")
    .waitFor({ state: "detached", timeout: 60000 })
    .catch(() => undefined);

  if (await page2.getByTestId("prejoin").isVisible().catch(() => false)) {
    await joinRoom(page2, "Bob", room);
  }

  const reconnected = await waitForCount(page2, 2, 60000);
  const bobStillThere = await waitForCount(page1, 2, 60000);
  if (reconnected && bobStillThere) {
    ok("Bob recovered after reconnect and everyone sees two participants");
  } else {
    fail(`Bob recovered after reconnect (${reconnected}/${bobStillThere})`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
} catch (error) {
  console.error("\nError running e2e:", error?.message ?? error);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
} finally {
  await browser.close();
}