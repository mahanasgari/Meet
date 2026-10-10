// Keeps yt-dlp current without `yt-dlp -U` (which asks the GitHub API and
// gets rate-limited on shared server addresses). The latest tag comes from
// the releases/latest redirect, the file from the plain download URL; the
// new binary must report the expected version before it replaces the old.
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const RELEASES = "https://github.com/yt-dlp/yt-dlp/releases";

/** "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.02" → "2026.10.02". */
export function tagFromLocation(loc) {
  const m = /\/releases\/tag\/([0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?)\/?$/.exec(String(loc || ""));
  return m ? m[1] : null;
}

export async function latestVersion() {
  const r = await fetch(`${RELEASES}/latest`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  return tagFromLocation(r.headers.get("location"));
}

function runVersion(bin) {
  return new Promise((resolve) => {
    const c = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const t = setTimeout(() => c.kill("SIGKILL"), 30_000);
    c.stdout.on("data", (d) => (out += d));
    c.on("error", () => resolve(null));
    c.on("close", () => {
      clearTimeout(t);
      resolve(out.trim() || null);
    });
  });
}

/**
 * Updates the yt-dlp at [target] to the latest release when it's older.
 * Returns { installed, latest, updated, error }.
 */
export async function updateYtdlp(target, installed) {
  const out = { installed, latest: null, updated: false, error: null };
  try {
    accessSync(dirname(target), constants.W_OK);
  } catch {
    out.error = "not writable";
    return out;
  }
  try {
    out.latest = await latestVersion();
    if (!out.latest) throw new Error("no latest tag");
    if (out.latest === installed) return out;
    const r = await fetch(`${RELEASES}/download/${out.latest}/yt-dlp`, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1_000_000) throw new Error("download too small");
    const tmp = join(dirname(target), ".yt-dlp.new");
    writeFileSync(tmp, buf);
    chmodSync(tmp, 0o755);
    const v = await runVersion(tmp);
    if (v !== out.latest) {
      rmSync(tmp, { force: true });
      throw new Error(`new binary says ${v}`);
    }
    renameSync(tmp, target);
    out.installed = v;
    out.updated = true;
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
  }
  return out;
}
