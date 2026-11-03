// Text helpers shared by the search index (insert side) and smart search
// (query side): both must normalise exactly the same way.

const COMBINING = /[̀-ًͯ-ٰٟۖ-ۭ]/g; // Latin accents, Arabic harakat
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g; // ZWNJ/ZWJ/RLM... (ZWNJ also splits words)
const DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };

/** Arabic letter variants to the Persian ones, tatweel gone, digits to ASCII. */
export function persianFold(s) {
  return String(s ?? "")
    .replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/ـ/g, "")
    .replace(/[أإٱ]/g, "ا").replace(/ۀ/g, "ه").replace(/ة/g, "ه")
    .replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d]);
}

/** Search text: folded, accents/diacritics off, lowercase, every non letter/digit run a single space. */
export function normSearch(s) {
  return persianFold(String(s ?? "").normalize("NFKD"))
    .replace(COMBINING, "").replace(INVISIBLE, " ").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const JUNK_TAGS = new Set(["seen live", "favorites", "favourites", "favorite", "favourite", "albums i own",
  "my music", "spotify", "love", "awesome", "good", "best", "check out", "under 2000 listeners", "all"]);

/** Cleaned tag, or null for junk (too long, pure year, "seen live"...). */
export function cleanTag(raw) {
  const t = persianFold(String(raw ?? "")).replace(INVISIBLE, " ").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t || t.length > 40) return null;
  if (/^\d{4}s?$/.test(t) || /^\d+$/.test(t)) return null;
  if (JUNK_TAGS.has(t)) return null;
  return t;
}

/** Common mood words (English/Persian) mapped to the analysis mood tags. */
export const MOOD_WORDS = {
  sad: "sad", "غمگین": "sad", "غمناک": "sad", "گریه": "sad", "دپ": "sad",
  happy: "happy", "شاد": "happy", "خوشحال": "happy",
  chill: "relaxed", relax: "relaxed", relaxed: "relaxed", relaxing: "relaxed", calm: "relaxed", "آرام": "relaxed", "ریلکس": "relaxed",
  party: "party", dance: "party", "رقص": "party", "رقصی": "party", "پارتی": "party",
  energetic: "aggressive", workout: "aggressive", aggressive: "aggressive", "پرانرژی": "aggressive",
};

export const MOODS = ["happy", "sad", "relaxed", "aggressive", "party"];
