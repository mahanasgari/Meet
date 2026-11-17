// "Play on my other device" (like Spotify Connect): an account's devices
// (phone, PC, web) see each other and send each other commands — move the
// playing queue to another device, then pause / skip / seek / volume it
// from here. Kept in memory on home (like Listen Together rooms): nothing
// to keep once the apps are closed.
//
// Each open app long-polls POST /connect/poll: it says who it is and what
// it's playing, and gets the commands sent to it (or waits up to ~20 s for
// one) plus the account's other devices. POST /connect/send queues a
// command for one of them.

const ONLINE_MS = 45_000; // a device that hasn't polled for this long is gone
const MAX_WAIT_MS = 20_000;
const MAX_QUEUED = 50;
export const CONNECT_COMMANDS = new Set(["transfer", "play", "pause", "next", "prev", "seek", "volume", "stop"]);

const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

function cleanState(s) {
  if (!s || typeof s !== "object") return null;
  const t = s.track && typeof s.track === "object" ? s.track : null;
  return {
    track: t ? { id: str(t.id, 64), title: str(t.title, 200), artist: str(t.artist, 160), art: str(t.art, 400) || null } : null,
    playing: Boolean(s.playing),
    positionMs: Math.max(0, Math.round(Number(s.positionMs) || 0)),
    durationMs: Math.max(0, Math.round(Number(s.durationMs) || 0)),
    volume: Math.max(0, Math.min(100, Math.round(Number(s.volume) || 0))),
  };
}

export class Connect {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** uid -> { devices: Map<id, device>, queues: Map<id, cmd[]>, waiters: Set<fn>, seq } */
    this.users = new Map();
  }

  #user(uid) {
    let u = this.users.get(uid);
    if (!u) {
      u = { devices: new Map(), queues: new Map(), waiters: new Set(), seq: 0 };
      this.users.set(uid, u);
    }
    return u;
  }

  /** [device] checks in (name, platform, what it plays). */
  hello(uid, { id, name, platform, state }) {
    const devId = str(id, 64);
    if (!devId) return null;
    const u = this.#user(uid);
    const before = u.devices.get(devId);
    const d = {
      id: devId,
      name: str(name, 60) || before?.name || "Device",
      platform: str(platform, 20) || before?.platform || "",
      seen: this.now(),
      state: state === undefined ? before?.state ?? null : cleanState(state),
      stateAt: state === undefined ? before?.stateAt ?? 0 : this.now(),
    };
    u.devices.set(devId, d);
    // A new device, or a playing state change: the others hear of it.
    if (!before || JSON.stringify(before.state) !== JSON.stringify(d.state)) this.#wake(u);
    return d;
  }

  /** The account's devices online now (but [except]), newest first. */
  devices(uid, except = null) {
    const u = this.users.get(uid);
    if (!u) return [];
    const now = this.now();
    const out = [];
    for (const d of u.devices.values()) {
      if (now - d.seen > ONLINE_MS) {
        u.devices.delete(d.id);
        u.queues.delete(d.id);
        continue;
      }
      if (d.id !== except) out.push({ id: d.id, name: d.name, platform: d.platform, state: d.state, stateAt: d.stateAt });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Queues [cmd] for device [target] of [uid]. False when it isn't online. */
  send(uid, from, target, cmd, args = {}) {
    if (!CONNECT_COMMANDS.has(cmd)) return false;
    const u = this.users.get(uid);
    if (!u || !this.devices(uid).some((d) => d.id === target)) return false;
    const q = u.queues.get(target) || [];
    q.push({ seq: ++u.seq, cmd, args: args && typeof args === "object" ? args : {}, from: str(from, 64), at: this.now() });
    if (q.length > MAX_QUEUED) q.splice(0, q.length - MAX_QUEUED);
    u.queues.set(target, q);
    this.#wake(u);
    return true;
  }

  /**
   * Commands for [deviceId] after [since]. The device sends back the last
   * seq it got as [since] on its next poll: only then are those dropped (a
   * poll cut off on the way loses nothing).
   */
  take(uid, deviceId, since = 0) {
    const u = this.users.get(uid);
    const q = (u?.queues.get(deviceId) || []).filter((c) => c.seq > since);
    if (u) u.queues.set(deviceId, q);
    return q;
  }

  /**
   * Waits (up to [waitMs]) for a command for [deviceId] or a change among
   * the devices, then answers { commands, devices }.
   */
  async poll(uid, deviceId, { since = 0, waitMs = MAX_WAIT_MS, known = null } = {}) {
    const u = this.#user(uid);
    const ready = () => {
      const q = u.queues.get(deviceId) || [];
      if (q.some((c) => c.seq > since)) return true;
      return known != null && known !== this.#devicesKey(uid, deviceId);
    };
    if (!ready() && waitMs > 0) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          u.waiters.delete(check);
          resolve();
        };
        const check = () => {
          if (ready()) done();
        };
        const timer = setTimeout(done, Math.min(waitMs, MAX_WAIT_MS));
        timer.unref?.();
        u.waiters.add(check);
      });
    }
    return { commands: this.take(uid, deviceId, since), devices: this.devices(uid, deviceId), key: this.#devicesKey(uid, deviceId) };
  }

  /** Changes when a device comes, goes or its playing state changes. */
  #devicesKey(uid, except) {
    return this.devices(uid, except)
      .map((d) => `${d.id}:${d.stateAt}`)
      .join(",");
  }

  #wake(u) {
    for (const fn of [...u.waiters]) fn();
  }
}
