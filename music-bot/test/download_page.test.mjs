import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderDownloadPage } from "../src/download_page.js";

test("lists the published files with sizes and escapes text", () => {
  const html = renderDownloadPage({
    version: "1.0.0", build: 23,
    files: {
      "android-arm64": { name: "MiniPlayer-1.0.0-23-arm64.apk", size: 30_000_000 },
      windows: { name: "MiniPlayer-1.0.0-23-windows-setup.exe", size: 18_000_000 },
    },
  });
  assert.match(html, /href="files\/MiniPlayer-1\.0\.0-23-arm64\.apk"/);
  assert.match(html, /build 23/);
  assert.match(html, /29 MB/);
  assert.doesNotMatch(html, /linux-deb|Linux \(\.deb\)/);
});

test("no release yet still renders", () => {
  assert.match(renderDownloadPage(null), /No release published yet/);
});
