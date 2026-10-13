import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { VIDEO_FORMAT, classifyYtdlpError, needsVideo, pickOfficialVideo, serveVideoFromTelegram, videoCaption } from "../src/video.js";

test("needsVideo", () => {
  assert.equal(needsVideo({ sourceKind: "ytm_track" }), false);
  assert.equal(needsVideo({ sourceKind: "ytm_video" }), true);
  assert.equal(needsVideo(null), true);
  assert.match(VIDEO_FORMAT, /\/18$/);
});

test("videoCaption", () => {
  const c = videoCaption("abcdefghijk", {
    title: "Song", artist: "Me", width: 1280, height: 720, vcodec: "h264", fps: 25,
    acodec: "aac", size: 21073920, durationS: 247,
  });
  assert.equal(c, "🎬 Song\n👤 Me\n📺 1280×720 · H264 · 25 fps\n🎧 AAC\n💾 20.1 MB · 4:07\nyoutu.be/abcdefghijk");
  assert.equal(videoCaption("abcdefghijk", {}), "🎬 abcdefghijk\nyoutu.be/abcdefghijk");
  assert.ok(videoCaption("x", { title: "t".repeat(3000) }).length <= 1024);
});

test("classifyYtdlpError", () => {
  assert.equal(classifyYtdlpError("ERROR: Sign in to confirm you’re not a bot"), "blocked");
  assert.equal(classifyYtdlpError("HTTP Error 429: Too Many Requests"), "blocked");
  assert.equal(classifyYtdlpError("ERROR: Requested format is not available"), "none");
  assert.equal(classifyYtdlpError("ERROR: Private video"), "unavailable");
  assert.equal(classifyYtdlpError("boom"), "failed");
  assert.equal(classifyYtdlpError(""), "failed");
});

function fakeTg(data, state) {
  return {
    async open() {
      return {
        size: data.length, mime: "video/mp4",
        async *read(off, len) {
          for (let p = off; p < off + len; p += 1000) {
            state.reads++;
            await new Promise((r) => setTimeout(r, 2));
            yield data.subarray(p, Math.min(p + 1000, off + len));
          }
        },
      };
    },
  };
}

async function withServer(tg, fn) {
  const srv = createServer((req, res) => void serveVideoFromTelegram(req, res, tg, 5, { size: 0, source: "telegram:t" }));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${srv.address().port}/`); } finally { srv.closeAllConnections(); srv.close(); }
}

test("serveVideoFromTelegram: full and Range", async () => {
  const data = randomBytes(20_000);
  await withServer(fakeTg(data, { reads: 0 }), async (url) => {
    const r = await fetch(url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("accept-ranges"), "bytes");
    assert.equal(r.headers.get("x-mp-source"), "telegram:t");
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(data));
    const p = await fetch(url, { headers: { Range: "bytes=1500-4999" } });
    assert.equal(p.status, 206);
    assert.equal(p.headers.get("content-range"), "bytes 1500-4999/20000");
    assert.ok(Buffer.from(await p.arrayBuffer()).equals(data.subarray(1500, 5000)));
    const bad = await fetch(url, { headers: { Range: "bytes=99999-" } });
    assert.equal(bad.status, 416);
  });
});

test("serveVideoFromTelegram: client abort stops reading", async () => {
  const data = randomBytes(2_000_000);
  const state = { reads: 0 };
  await withServer(fakeTg(data, state), async (url) => {
    const ac = new AbortController();
    const r = await fetch(url, { signal: ac.signal });
    const reader = r.body.getReader();
    await reader.read();
    ac.abort();
    await new Promise((r2) => setTimeout(r2, 300));
    const at = state.reads;
    await new Promise((r2) => setTimeout(r2, 200));
    assert.equal(state.reads, at);
    assert.ok(at < 2000);
  });
});

test("pickOfficialVideo finds the official video and rejects other songs", async () => {
  const { pickOfficialVideo } = await import("../src/video.js");
  const eshghe = [
    { videoId: "j3vAlrgBvoE", title: "Sami Beigi - In Eshghe I Official Video ( سامی بیگی - این عشقه )", subtitle: "Sami Beigi • 1.2M views • 3:52", durationS: 232 },
    { videoId: "kdSdnuGqaUc", title: "Sami Beigi - In Eshghe I Lyric Video", subtitle: "Sami Beigi • 21K views • 3:45", durationS: 225 },
  ];
  assert.equal(pickOfficialVideo(eshghe, { title: "In Eshghe", artist: "Sami Beigi", durationS: 225 })?.videoId, "j3vAlrgBvoE");
  const maleTo = [
    { videoId: "lr_a6NjkTL4", title: "Kamran & Hooman - Male To OFFICIAL VIDEO HD", subtitle: "Avang Music • 1.2M views • 4:25", durationS: 265 },
    { videoId: "Thu_s-vuBgM", title: "Kamran & Hooman - Man Ageh Nabasham Music Video", subtitle: "My College • 34 views • 4:53", durationS: 293 },
  ];
  assert.equal(pickOfficialVideo(maleTo, { title: "Male To", artist: "Kamran & Hooman", durationS: 227 })?.videoId, "lr_a6NjkTL4");
  assert.equal(pickOfficialVideo([{ videoId: "S59SaU-RDD4", title: "Chi Mishe Badet", subtitle: "Kiyarash", durationS: 192 }], { title: "Oftadi Mese Ashk", artist: "Kiyarash", durationS: 196 }), null);
  assert.equal(pickOfficialVideo([{ videoId: "j3vAlrgBvoE", title: "Sami Beigi - In Eshghe Official Video", subtitle: "x", durationS: 600 }], { title: "In Eshghe", artist: "Sami Beigi", durationS: 225 }), null, "length far off");
});

test("pickOfficialVideo rejects lyric, cover, remix and live versions when the song is none of them", () => {
  const want = { title: "In Eshghe", artist: "Sami Beigi", durationS: 225 };
  const bad = [
    { videoId: "aaaaaaaaaaa", title: "Sami Beigi - In Eshghe (Lyrics)", subtitle: "Sami Beigi • 1M views", durationS: 226 },
    { videoId: "bbbbbbbbbbb", title: "Sami Beigi - In Eshghe Cover", subtitle: "Some Fan", durationS: 225 },
    { videoId: "ccccccccccc", title: "Sami Beigi - In Eshghe (Remix)", subtitle: "DJ Someone", durationS: 225 },
    { videoId: "ddddddddddd", title: "Sami Beigi - In Eshghe Live Concert", subtitle: "Sami Beigi", durationS: 230 },
  ];
  assert.equal(pickOfficialVideo(bad, want), null);
  // A remix/live song is allowed to match those variants.
  assert.equal(pickOfficialVideo([bad[2]], { title: "In Eshghe Remix", artist: "Sami Beigi", durationS: 225 })?.videoId, "ccccccccccc");
});

test("pickOfficialVideo rejects a wrong-artist video with the right title", () => {
  const rows = [{ videoId: "eeeeeeeeeee", title: "Other Singer - In Eshghe Official Video", subtitle: "Other Singer", durationS: 225 }];
  assert.equal(pickOfficialVideo(rows, { title: "In Eshghe", artist: "Sami Beigi", durationS: 225 }), null);
});

test("pickOfficialVideo skips excluded ids and picks the next valid one", () => {
  const rows = [
    { videoId: "fffffffffff", title: "Sami Beigi - In Eshghe Official Video", subtitle: "Sami Beigi", durationS: 225 },
    { videoId: "ggggggggggg", title: "Sami Beigi - In Eshghe Official Music Video", subtitle: "Sami Beigi", durationS: 226 },
  ];
  const want = { title: "In Eshghe", artist: "Sami Beigi", durationS: 225 };
  assert.equal(pickOfficialVideo(rows, want)?.videoId, "fffffffffff");
  assert.equal(pickOfficialVideo(rows, want, { exclude: ["fffffffffff"] })?.videoId, "ggggggggggg");
  assert.equal(pickOfficialVideo(rows, want, { exclude: ["fffffffffff", "ggggggggggg"] }), null);
});

test("pickOfficialVideo returns null below the confidence bar", () => {
  // No artist given (default 0.6), no official keyword, length 300 vs 225: score ~0.70 < 0.72.
  const far = [{ videoId: "hhhhhhhhhhh", title: "In Eshghe", subtitle: "Somebody", durationS: 300 }];
  assert.equal(pickOfficialVideo(far, { title: "In Eshghe", durationS: 225 }), null);
  // Positive control: same row with an official keyword clears the bar.
  const ok = [{ videoId: "iiiiiiiiiii", title: "In Eshghe Official Video", subtitle: "Somebody", durationS: 300 }];
  assert.equal(pickOfficialVideo(ok, { title: "In Eshghe", durationS: 225 })?.videoId, "iiiiiiiiiii");
});

test("pickOfficialVideo matches Persian-letter variants", () => {
  // Arabic-letter upload title and artist vs Persian-letter song metadata.
  const rows = [{ videoId: "jjjjjjjjjjj", title: "سوگند - بليط يك طرفه OFFICIAL VIDEO", subtitle: "Sogand", durationS: 210 }];
  const got = pickOfficialVideo(rows, { title: "بلیط یک طرفه", artist: "سوگند", durationS: 210 });
  assert.equal(got?.videoId, "jjjjjjjjjjj");
  // Arabic-letter want vs Persian-letter upload.
  const arabicWant = pickOfficialVideo(rows, { title: "بليط يك طرفه", artist: "سوگند", durationS: 210 });
  assert.equal(arabicWant?.videoId, "jjjjjjjjjjj");
});
