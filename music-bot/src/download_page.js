// Public download page for MiniPlayer (served at <server>/app/), built from
// app/latest.json: the right file for the visitor's device first, plus the
// two install warnings friends will meet and the invite-code step.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;

const PLATFORMS = [
  { key: "android-arm64", os: "android", label: "Android", note: "Most phones" },
  { key: "android-arm", os: "android", label: "Android (older phones)", note: "If the first one won’t install" },
  { key: "windows", os: "windows", label: "Windows", note: "Installer" },
  { key: "linux-deb", os: "linux", label: "Linux (.deb)", note: "Ubuntu, Debian, Mint" },
  { key: "linux", os: "linux", label: "Linux (portable)", note: "Unpack and run" },
];

/** HTML for the download page; [manifest] is app/latest.json or null. */
export function renderDownloadPage(manifest) {
  const files = manifest?.files || {};
  const rows = PLATFORMS.filter((p) => files[p.key])
    .map((p) => {
      const f = files[p.key];
      return `<a class="dl" data-os="${p.os}" href="files/${encodeURIComponent(f.name)}" download>
  <span class="name">${esc(p.label)}</span>
  <span class="meta">${esc(p.note)} · ${mb(f.size)}</span>
</a>`;
    })
    .join("\n");
  const version = manifest
    ? `Version ${esc(manifest.version)} · build ${esc(manifest.build)}`
    : "No release published yet";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MiniPlayer · Download</title>
<style>
  :root { --bg:#0d0d0f; --card:#1a1a1e; --line:#2a2a30; --text:#f2f2f4; --muted:#9a9aa3; --accent:#ff2d55; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f5f2; --card:#ffffff; --line:#e4e2dd; --text:#141416; --muted:#6b6b72; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 40px 16px 56px; }
  .logo { width:56px; height:56px; border-radius:16px; background:var(--accent); display:grid; place-items:center; }
  .logo svg { width:30px; height:30px; }
  h1 { font-size: 30px; margin: 18px 0 4px; letter-spacing: -0.5px; }
  .sub { color: var(--muted); margin: 0 0 26px; }
  .dl { display:flex; flex-direction:column; gap:2px; padding:14px 16px; margin:10px 0; border-radius:14px;
        background:var(--card); border:1px solid var(--line); color:var(--text); text-decoration:none; }
  .dl .name { font-weight: 700; }
  .dl .meta { color: var(--muted); font-size: 14px; }
  .dl.best { border-color: var(--accent); }
  .dl.best .name::after { content: "  Recommended for this device"; color: var(--accent); font-weight: 600; font-size: 13px; }
  h2 { font-size: 19px; margin: 34px 0 8px; }
  ol { padding-left: 20px; margin: 0; }
  li { margin: 7px 0; }
  .muted { color: var(--muted); font-size: 14px; }
  code { background: var(--card); border:1px solid var(--line); padding: 1px 6px; border-radius: 6px; }
</style>
</head>
<body>
<main>
  <div class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="#fff"><path d="M7 5.5v13l10-6.5z"/></svg></div>
  <h1>MiniPlayer</h1>
  <p class="sub">Music from YouTube, light and fast. ${version}</p>

  ${rows || '<p class="muted">Nothing to download yet.</p>'}

  <h2>Installing on Android</h2>
  <ol>
    <li>Open the downloaded file. If Android asks, allow installing apps from your browser (or Telegram).</li>
    <li>If <b>Google Play Protect</b> says it hasn’t seen the app, tap <b>Scan app</b> (or <b>Install anyway</b>).</li>
    <li>Open MiniPlayer and enter the <b>invite code</b> you were given.</li>
  </ol>

  <h2>Installing on Windows or Linux</h2>
  <ol>
    <li>Windows: run the installer. If SmartScreen warns, choose <b>More info → Run anyway</b>.</li>
    <li>Linux: open the <code>.deb</code>, or unpack the portable file and run <code>mini_player</code>.</li>
    <li>Open MiniPlayer and enter your invite code.</li>
  </ol>

  <p class="muted" style="margin-top:28px">After this, MiniPlayer updates itself. No code? Ask the person who sent you this page.</p>
</main>
<script>
  // Highlight the download that fits this device.
  const ua = navigator.userAgent.toLowerCase();
  const os = /android/.test(ua) ? "android" : /windows/.test(ua) ? "windows" : /linux|x11/.test(ua) ? "linux" : "";
  const best = document.querySelector('.dl[data-os="' + os + '"]');
  if (best) { best.classList.add("best"); best.parentNode.insertBefore(best, best.parentNode.querySelector(".dl")); }
</script>
</body>
</html>`;
}
