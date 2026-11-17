// Every song an account played (the app's History), kept forever and the
// same on all the user's devices. One shared record per user per month
// ("<uid>:<YYYY-MM>", collection play_history), so it syncs between servers
// like the other shared records and a month is small (a heavy listener:
// ~2000 plays, ~250 KB).
//
// A play: { id, t (title), a (artist), at (start, ms), s (seconds heard),
//   d (song length, s), f (played to the end), imp (from the app's old
//   History list, no real time) } — or a removal
//   { id, at, del: 1 } (the user deleted it; kept so other devices delete
//   it too).
export const HISTORY_COLL = "play_history";
const MAX_PER_MONTH = 20_000;
const MONTH = /^\d{4}-\d{2}$/;

const monthOf = (at) => new Date(at).toISOString().slice(0, 7);
const keyOf = (e) => `${e.id}@${e.at}`;
const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const num = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
};

/** A play from the app, checked; null when it isn't one. */
export function cleanPlay(e, now = Date.now()) {
  if (!e || typeof e !== "object") return null;
  const id = str(e.id, 64);
  const at = Number(e.at);
  if (!id || !Number.isFinite(at) || at < Date.UTC(2020, 0, 1) || at > now + 864e5) return null;
  if (e.del) return { id, at, del: 1 };
  return {
    id,
    t: str(e.t, 200),
    a: str(e.a, 160),
    at,
    s: num(e.s, 0, 86_400),
    d: num(e.d, 0, 86_400),
    ...(e.f ? { f: 1 } : {}),
    ...(e.imp ? { imp: 1 } : {}),
  };
}

/** [b] merged into [a] (the same play): removal wins, longest listen wins. */
function mergeOne(a, b) {
  if (!a) return b;
  if (a.del || b.del) return { id: a.id, at: a.at, del: 1 };
  return {
    ...a,
    t: b.t || a.t,
    a: b.a || a.a,
    s: Math.max(a.s || 0, b.s || 0),
    d: Math.max(a.d || 0, b.d || 0),
    ...(a.f || b.f ? { f: 1 } : {}),
    ...(a.imp || b.imp ? { imp: 1 } : {}),
  };
}

export class PlayHistory {
  /** @param {import("./shared_docs.js").SharedDocs} docs */
  constructor(docs) {
    this.docs = docs;
  }

  /** Adds [plays] for [uid]. Returns how many were new or changed. */
  add(uid, plays, now = Date.now()) {
    const byMonth = new Map();
    for (const raw of Array.isArray(plays) ? plays : []) {
      const p = cleanPlay(raw, now);
      if (!p) continue;
      const m = monthOf(p.at);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(p);
    }
    let changed = 0;
    for (const [m, list] of byMonth) {
      const id = `${uid}:${m}`;
      const doc = this.docs.get(HISTORY_COLL, id);
      const map = new Map((doc?.e || []).map((e) => [keyOf(e), e]));
      let n = 0;
      for (const p of list) {
        const before = map.get(keyOf(p));
        const after = mergeOne(before, p);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          map.set(keyOf(p), after);
          n++;
        }
      }
      if (!n) continue;
      let e = [...map.values()].sort((x, y) => x.at - y.at);
      if (e.length > MAX_PER_MONTH) e = e.slice(-MAX_PER_MONTH);
      this.docs.put(HISTORY_COLL, id, { e }, now);
      changed += n;
    }
    return changed;
  }

  /**
   * [uid]'s months changed after [since] (ms; 0 = everything):
   * { months: { "YYYY-MM": [plays] }, now }. Pass [now] back next time.
   */
  since(uid, since = 0, now = Date.now()) {
    const months = {};
    const rows = this.docs.db
      .prepare("SELECT id, body FROM docs WHERE coll=? AND id >= ? AND id < ? AND updated_at > ?")
      .iterate(HISTORY_COLL, `${uid}:`, `${uid};`, Number(since) || 0);
    for (const r of rows) {
      const m = r.id.slice(uid.length + 1);
      if (!MONTH.test(m)) continue;
      try {
        months[m] = JSON.parse(r.body).e || [];
      } catch {
        // a broken record: skipped
      }
    }
    return { months, now };
  }
}
