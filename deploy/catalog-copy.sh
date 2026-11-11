#!/bin/bash
# Puts a full copy of the music catalog on this mirror (run on the mirror as
# root: ssh <mirror> 'bash -s' < deploy/catalog-copy.sh [SOURCE_URL]).
# SOURCE_URL: a server with a catalog snapshot (default: home, from the
# container's HOME_URL). The copy carries its sync positions, so the music
# bot keeps it in step with home after the restart. Needs the music-bot
# image with catalog_sync (Phase 1).
set -euo pipefail
SRC="${1:-}"
C="$(docker ps --format '{{.Names}}' | grep -m1 -E '^music-bot$|music' || true)"
[ -n "$C" ] || { echo "no music container"; exit 1; }
VOL="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/shares"}}{{.Source}}{{end}}{{end}}' "$C")"
FREE_GB=$(df -BG --output=avail "$VOL" | tail -1 | tr -dc 0-9)
[ "$FREE_GB" -ge 4 ] || { echo "only ${FREE_GB} GB free; need 4"; exit 1; }
echo "$(hostname): downloading the catalog copy (about 1.6 GB)…"
docker exec -e SRC="$SRC" "$C" node -e '
const { createWriteStream, renameSync, rmSync, mkdirSync, statSync } = require("node:fs");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { DatabaseSync } = require("node:sqlite");
(async () => {
  const base = (process.env.SRC || process.env.HOME_URL || "").replace(/\/+$/, "");
  const dir = "/shares/catalog";
  mkdirSync(dir, { recursive: true });
  const part = dir + "/catalog.db.part";
  const t = Date.now();
  const r = await fetch(base + "/sync/catalog/snapshot", { headers: { authorization: "Bearer " + process.env.MUSIC_API_TOKEN } });
  if (!r.ok) throw new Error("snapshot: HTTP " + r.status);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(part)); // fetch undoes the gzip
  const want = Number(r.headers.get("x-snapshot-bytes"));
  const got = statSync(part).size;
  if (want && got !== want) throw new Error(`size ${got} != ${want}`);
  const db = new DatabaseSync(part);
  const ok = db.prepare("PRAGMA quick_check").get().quick_check;
  const pos = db.prepare("SELECT key, value FROM meta WHERE key LIKE '\''sync_from:%'\''").all();
  const songs = db.prepare("SELECT COUNT(*) n FROM songs WHERE status='\''stored'\''").get().n;
  db.close();
  if (ok !== "ok") throw new Error("quick_check: " + ok);
  if (!pos.length) throw new Error("the snapshot has no sync position (made before sync was on): wait for the next one");
  for (const f of ["catalog.db-wal", "catalog.db-shm"]) rmSync(dir + "/" + f, { force: true });
  renameSync(part, dir + "/catalog.db");
  console.log(`ok: ${Math.round(got / 1048576)} MB in ${Math.round((Date.now() - t) / 1000)} s, ${songs} stored songs, from`, Object.fromEntries(pos.map((p) => [p.key.slice(10), Number(p.value)])));
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
' 2>&1 | grep -v ExperimentalWarning
docker exec -u 0 "$C" chown -R 1000:1000 /shares/catalog
docker restart "$C" >/dev/null
sleep 20
docker logs --since 30s "$C" 2>&1 | grep -E "\[sync\]" | tail -3
