// Bale-backed audio store (secondary archive): songs as Bot API audio
// messages in a channel. Telegram remains primary; Bale mirrors files that
// fit the Bot API download cap (~20 MB via getFile).
import { basename } from "node:path";
import { statSync } from "node:fs";

const DEFAULT_API = "https://tapi.bale.ai";
/** Bale docs: bots can download files up to ~20 MB via getFile. */
export const BALE_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Bale docs: sendAudio / sendDocument up to ~50 MB. */
export const BALE_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const CONNECT_RETRY_GAP_MS = 30_000;
const MAX_FLOOD_RETRIES = 3;
const FILE_TTL_MS = 30 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String(e?.message || e || "");

export class BaleStore {
  /**
   * @param {{ botToken: string, channelId: string|number, apiBase?: string,
   *   minUploadIntervalMs?: number, log?: Console, fetch?: typeof fetch,
   *   now?: () => number, maxDownloadBytes?: number }} opts
   */
  constructor({
    botToken,
    channelId,
    apiBase = DEFAULT_API,
    minUploadIntervalMs = 8000,
    log = console,
    fetch: fetchFn = globalThis.fetch,
    now = Date.now,
    maxDownloadBytes = BALE_MAX_DOWNLOAD_BYTES,
  } = {}) {
    this.botToken = botToken;
    this.channelId = channelId;
    this.apiBase = String(apiBase || DEFAULT_API).replace(/\/+$/, "");
    this.minUploadIntervalMs = minUploadIntervalMs;
    this.log = log;
    this.fetch = fetchFn;
    this.now = now;
    this.maxDownloadBytes = maxDownloadBytes;
    this._ready = false;
    this._connecting = null;
    this._lastFailAt = null;
    this._lastFailMsg = "";
    this._retryGapMs = CONNECT_RETRY_GAP_MS;
    this._uploadChain = Promise.resolve();
    this._lastUploadStart = 0;
    this._files = new Map(); // fileId -> { size, mime, path, at }
  }

  get ready() {
    return this._ready;
  }

  /** Stable key used in the catalog backups table. */
  get backupChannel() {
    return `bale:${this.channelId}`;
  }

  connect() {
    if (this._ready) return Promise.resolve();
    if (this._connecting) return this._connecting;
    if (this._lastFailAt !== null && this.now() - this._lastFailAt < this._retryGapMs) {
      return Promise.reject(new Error(`bale unavailable, retrying soon (${this._lastFailMsg})`));
    }
    const p = this._doConnect().then(
      () => {
        this._ready = true;
        this._lastFailAt = null;
        this._connecting = null;
      },
      (e) => {
        this._lastFailAt = this.now();
        this._lastFailMsg = errText(e).slice(0, 120);
        this._retryGapMs = CONNECT_RETRY_GAP_MS;
        this._connecting = null;
        this._ready = false;
        throw new Error(`bale connect failed: ${this._lastFailMsg}`);
      },
    );
    this._connecting = p;
    return p;
  }

  async _doConnect() {
    const me = await this._api("getMe");
    if (!me?.id) throw new Error("getMe empty");
    const chat = await this._api("getChat", { chat_id: this.channelId }).catch((e) => {
      throw new Error(`getChat: ${errText(e)}`);
    });
    if (!chat?.id) throw new Error("channel not found");
  }

  async _api(method, body, { form, timeoutMs = 60_000 } = {}) {
    const url = `${this.apiBase}/bot${this.botToken}/${method}`;
    const init = { method: "POST", signal: AbortSignal.timeout(timeoutMs) };
    if (form) init.body = form;
    else if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const r = await this.fetch(url, init);
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${method}: HTTP ${r.status} non-json`);
    }
    if (!data.ok) {
      const desc = data.description || `HTTP ${r.status}`;
      const err = new Error(`${method}: ${desc}`);
      const m = /retry after (\d+)/i.exec(desc);
      if (m) err.seconds = Number(m[1]);
      if (/FLOOD|Too Many|retry after/i.test(desc)) err.flood = true;
      throw err;
    }
    return data.result;
  }

  async uploadAudio(path, { title, artist, durationS, caption, fileName } = {}) {
    const run = async () => {
      await this.connect();
      const wait = this._lastUploadStart + this.minUploadIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      const st = statSync(path);
      if (st.size > BALE_MAX_UPLOAD_BYTES) {
        throw new Error(`upload too large: ${st.size} > ${BALE_MAX_UPLOAD_BYTES}`);
      }
      // Only mirror what we can later download for playback.
      if (st.size > this.maxDownloadBytes) {
        throw new Error(`upload exceeds download cap: ${st.size} > ${this.maxDownloadBytes}`);
      }
      for (let attempt = 0; ; attempt++) {
        this._lastUploadStart = Date.now();
        try {
          const form = new FormData();
          form.append("chat_id", String(this.channelId));
          const name = fileName || basename(path) || "audio.m4a";
          const { openAsBlob } = await import("node:fs");
          form.append("audio", await openAsBlob(path), name);
          if (title) form.append("title", String(title).slice(0, 64));
          if (artist) form.append("performer", String(artist).slice(0, 64));
          if (durationS) form.append("duration", String(Math.round(durationS)));
          if (caption) form.append("caption", String(caption).slice(0, 1024));
          const msg = await this._api("sendAudio", undefined, { form, timeoutMs: 180_000 });
          const audio = msg?.audio || msg?.document || {};
          const fileId = audio.file_id;
          if (!fileId) throw new Error("sendAudio: no file_id");
          const size = Number(audio.file_size ?? st.size);
          const mime = audio.mime_type || "audio/mpeg";
          this._files.set(fileId, { size, mime, path: null, at: this.now() });
          return { msgId: msg.message_id, fileId, size, mime };
        } catch (e) {
          const secs = typeof e.seconds === "number" ? e.seconds : e.flood ? 5 : null;
          if (secs === null || attempt >= MAX_FLOOD_RETRIES) {
            throw new Error(`upload failed: ${errText(e).slice(0, 160)}`);
          }
          this.log.warn?.(`bale flood wait ${secs}s (attempt ${attempt + 1})`);
          await sleep(secs * 1000 + 500);
        }
      }
    };
    const p = this._uploadChain.then(run, run);
    this._uploadChain = p.catch(() => {});
    return p;
  }

  async _resolveFile(fileId, force = false) {
    const hit = this._files.get(fileId);
    if (!force && hit?.path && this.now() - hit.at < FILE_TTL_MS) return hit;
    await this.connect();
    const info = await this._api("getFile", { file_id: fileId });
    const size = Number(info.file_size ?? hit?.size ?? 0);
    if (size > this.maxDownloadBytes) throw new Error(`file too large to download: ${size}`);
    if (!info.file_path) throw new Error("getFile: no file_path");
    const meta = { size, mime: hit?.mime || "audio/mpeg", path: info.file_path, at: this.now() };
    this._files.set(fileId, meta);
    return meta;
  }

  /**
   * Same shape as TgStore.open: { size, mime, read(offset, length) }.
   * [fileId] is the Bale Bot API file_id (not message id).
   */
  async open(fileId) {
    const meta = await this._resolveFile(fileId);
    const size = meta.size;
    const mime = meta.mime;
    const self = this;
    async function* read(offset = 0, length = Infinity) {
      const start = Math.max(0, offset);
      const end = Math.min(size, length === Infinity ? size : start + length);
      if (start >= end) return;
      let meta2 = meta;
      let refreshed = false;
      for (;;) {
        try {
          const url = `${self.apiBase}/file/bot${self.botToken}/${meta2.path}`;
          const wantRange = start > 0 || end < size;
          const r = await self.fetch(url, {
            headers: wantRange ? { Range: `bytes=${start}-${end - 1}` } : {},
            signal: AbortSignal.timeout(180_000),
          });
          if (r.status === 416) return;
          if (!r.ok) throw new Error(`download HTTP ${r.status}`);
          const ranged = Boolean(r.headers.get("content-range"));
          const buf = Buffer.from(await r.arrayBuffer());
          if (ranged) {
            if (buf.length) yield buf.subarray(0, Math.min(buf.length, end - start));
            return;
          }
          const slice = buf.subarray(start, end);
          if (slice.length) yield slice;
          return;
        } catch (e) {
          if (!refreshed && /expired|not found|404|wrong/i.test(errText(e))) {
            refreshed = true;
            meta2 = await self._resolveFile(fileId, true);
            continue;
          }
          throw new Error(`download failed: ${errText(e).slice(0, 120)}`);
        }
      }
    }
    return { size, mime, read };
  }

  async delete(msgId) {
    await this.connect();
    await this._api("deleteMessage", { chat_id: this.channelId, message_id: Number(msgId) }).catch(() => {});
  }

  async close() {
    this._ready = false;
    this._files.clear();
  }
}
