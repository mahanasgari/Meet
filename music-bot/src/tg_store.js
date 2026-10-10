// Telegram-backed audio store: songs live as audio messages in a private
// channel, accessed through GramJS (MTProto) logged in as a bot.
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from "node:fs";

const REQUEST_SIZE = 512 * 1024; // divides 1 MiB, multiple of 4096
const MSG_TTL_MS = 30 * 60 * 1000;
const CONNECT_RETRY_GAP_MS = 30 * 1000;
const MAX_FLOOD_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String(e?.errorMessage || e?.message || e || "");
const isFileRef = (e) => /FILE_REFERENCE_/.test(errText(e));
function floodSeconds(e) {
  if (typeof e?.seconds === "number") return e.seconds;
  const m = /FLOOD_WAIT_(\d+)/.exec(errText(e));
  return m ? Number(m[1]) : null;
}

async function defaultFactory(session, { apiId, apiHash }) {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const client = new TelegramClient(new StringSession(session), Number(apiId), apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });
  client.setLogLevel("error");
  return client;
}

export class TgStore {
  constructor({
    apiId, apiHash, botToken, channelId, sessionFile,
    minUploadIntervalMs = 12000, log = console, clientFactory, now = Date.now, bigInt, Api, floodPadMs = 1000,
  } = {}) {
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.botToken = botToken;
    this.channelId = channelId;
    this.sessionFile = sessionFile;
    this.minUploadIntervalMs = minUploadIntervalMs;
    this.log = log;
    this.now = now;
    this._factory = clientFactory || ((s) => defaultFactory(s, { apiId, apiHash }));
    this._bigInt = bigInt || null;
    this._Api = Api || null;
    this.floodPadMs = floodPadMs;
    this._client = null;
    this._peer = null;
    this._connecting = null;
    this._ready = false;
    this._lastFailAt = null;
    this._lastFailMsg = "";
    this._uploadChain = Promise.resolve();
    this._lastUploadStart = 0;
    this._msgs = new Map();
  }

  get ready() { return this._ready; }

  _readSession() {
    try {
      if (this.sessionFile && existsSync(this.sessionFile)) return readFileSync(this.sessionFile, "utf8").trim();
    } catch {}
    return "";
  }

  _saveSession(str) {
    if (!this.sessionFile || !str) return;
    if (str === this._readSession()) return;
    const tmp = `${this.sessionFile}.${process.pid}.tmp`;
    writeFileSync(tmp, str, { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, this.sessionFile);
  }

  connect() {
    if (this._ready) return Promise.resolve();
    if (this._connecting) return this._connecting;
    if (this._lastFailAt !== null && this.now() - this._lastFailAt < (this._retryGapMs || CONNECT_RETRY_GAP_MS)) {
      return Promise.reject(new Error(`telegram unavailable, retrying soon (${this._lastFailMsg})`));
    }
    const p = this._doConnect().then(
      () => { this._ready = true; this._lastFailAt = null; this._connecting = null; },
      (e) => {
        this._lastFailAt = this.now();
        this._lastFailMsg = errText(e).slice(0, 120);
        // Telegram asks bots to back off after too many logins (FLOOD_WAIT):
        // wait as long as it says, or every retry extends the ban.
        const wait = Number(e?.seconds) || Number(/FLOOD_WAIT_(\d+)/.exec(errText(e))?.[1]) || (/FLOOD/i.test(errText(e)) ? 600 : 0);
        this._retryGapMs = Math.max(CONNECT_RETRY_GAP_MS, wait * 1000 + 5000);
        this._connecting = null;
        this._ready = false;
        throw new Error(`telegram connect failed: ${this._lastFailMsg}`);
      },
    );
    this._connecting = p;
    return p;
  }

  async _doConnect() {
    const session = this._readSession();
    const client = await this._factory(session);
    try {
      await client.start({ botAuthToken: this.botToken });
      this._saveSession(client.session.save());
      const id = typeof this.channelId === "string" && /^-?\d+$/.test(this.channelId)
        ? Number(this.channelId) : this.channelId;
      this._peer = await client.getEntity(id);
    } catch (e) {
      try { await client.disconnect(); } catch {}
      throw e;
    }
    this._client = client;
  }

  async uploadAudio(path, { title, artist, durationS, thumbPath, caption } = {}) {
    const run = async () => {
      await this.connect();
      const wait = this._lastUploadStart + this.minUploadIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      for (let attempt = 0; ; attempt++) {
        this._lastUploadStart = Date.now();
        try {
          if (!this._Api) this._Api = (await import("telegram")).Api;
          const Api = this._Api;
          const msg = await this._client.sendFile(this._peer, {
            file: path,
            caption: caption || "",
            forceDocument: false,
            attributes: [new Api.DocumentAttributeAudio({
              duration: Math.round(durationS || 0), title, performer: artist,
            })],
            ...(thumbPath ? { thumb: thumbPath } : {}),
          });
          const doc = msg?.media?.document || msg?.document;
          return { msgId: msg.id, size: Number(doc?.size ?? 0), mime: doc?.mimeType || "audio/mpeg" };
        } catch (e) {
          const secs = floodSeconds(e);
          if (secs === null || attempt >= MAX_FLOOD_RETRIES) throw new Error(`upload failed: ${errText(e).slice(0, 120)}`);
          this.log.warn?.(`tg flood wait ${secs}s (attempt ${attempt + 1})`);
          await sleep(secs * 1000 + this.floodPadMs);
        }
      }
    };
    const p = this._uploadChain.then(run, run);
    this._uploadChain = p.catch(() => {});
    return p;
  }

  async _getMsg(msgId, force = false) {
    const hit = this._msgs.get(msgId);
    if (!force && hit && this.now() - hit.at < MSG_TTL_MS) return hit.msg;
    await this.connect();
    const res = await this._client.getMessages(this._peer, { ids: [msgId] });
    const msg = Array.isArray(res) ? res[0] : res;
    if (!msg || !msg.media) { this._msgs.delete(msgId); throw new Error("message not found"); }
    this._msgs.set(msgId, { msg, at: this.now() });
    return msg;
  }

  async _big(n) {
    if (!this._bigInt) this._bigInt = (await import("big-integer")).default;
    return this._bigInt(n);
  }

  /** Replaces an archived message's caption (e.g. to add quality details). */
  async editCaption(msgId, caption) {
    await this.connect();
    await this._client.editMessage(this._peer, { message: Number(msgId), text: String(caption).slice(0, 1024) });
    this._msgs.delete(Number(msgId));
  }

  async open(msgId) {
    let msg = await this._getMsg(msgId);
    const doc = msg.media?.document || msg.document;
    const size = Number(doc?.size ?? 0);
    const mime = doc?.mimeType || "audio/mpeg";
    const self = this;
    async function* read(offset = 0, length = Infinity) {
      const start = Math.max(0, offset);
      const end = Math.min(size, length === Infinity ? size : start + length);
      let pos = start;
      let refreshed = false;
      while (pos < end) {
        const aligned = Math.floor(pos / REQUEST_SIZE) * REQUEST_SIZE;
        const limit = Math.ceil((end - aligned) / REQUEST_SIZE);
        try {
          const it = self._client.iterDownload({
            file: msg.media,
            offset: await self._big(aligned),
            requestSize: REQUEST_SIZE,
            limit,
          });
          let cpos = aligned;
          for await (const chunk of it) {
            const buf = Buffer.from(chunk);
            const cend = cpos + buf.length;
            if (cend > pos) {
              const out = buf.subarray(Math.max(0, pos - cpos), Math.min(buf.length, end - cpos));
              if (out.length) { pos += out.length; yield out; }
            }
            cpos = cend;
            if (pos >= end) break;
          }
          if (pos < end) throw new Error("download ended early");
        } catch (e) {
          if (isFileRef(e) && !refreshed) {
            refreshed = true;
            msg = await self._getMsg(msgId, true);
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
    await this._client.deleteMessages(this._peer, [msgId], { revoke: true });
    this._msgs.delete(msgId);
  }

  async close() {
    const c = this._client;
    this._client = null; this._peer = null; this._ready = false;
    if (c) { try { await c.disconnect(); } catch {} }
  }
}
