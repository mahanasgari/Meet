"""Pure result-shaping helpers (no essentia/numpy imports, unit-testable)."""

# Classes where the positive label is what we report as "the" probability.
POSITIVE = {
    "happy": "happy",
    "sad": "sad",
    "relaxed": "relaxed",
    "aggressive": "aggressive",
    "party": "party",
    "danceability": "danceable",
    "acoustic": "acoustic",
    "electronic": "electronic",
    "instrumental": "instrumental",
}


def class_column(classes, positive):
    """Index of the positive class in a model's .json "classes" list."""
    try:
        return list(classes).index(positive)
    except ValueError:
        raise ValueError(f"class {positive!r} not in {classes!r}") from None


def clamp01(x):
    x = float(x)
    if x != x:  # NaN
        return 0.0
    return min(1.0, max(0.0, x))


def mean_column(rows, col):
    """Mean of column [col] over rows (list of lists / 2-D array), clamped to 0..1."""
    vals = [float(r[col]) for r in rows]
    if not vals:
        raise ValueError("no frames")
    return clamp01(sum(vals) / len(vals))


def scale_emo(x):
    """emomusic outputs 1..9; map to 0..1."""
    return clamp01((float(x) - 1.0) / 8.0)


def top_genres(mean_probs, labels, k=3, min_p=0.1):
    """Top-[k] (label, p) with p > [min_p], as [{name, p}] (name = label as in the model)."""
    pairs = sorted(zip(labels, mean_probs), key=lambda t: -t[1])
    return [{"name": n, "p": round(clamp01(p), 4)} for n, p in pairs[:k] if p > min_p]


# Energy: RMS level in dBFS mapped linearly, -40 dB (or quieter) -> 0, -10 dB (or louder) -> 1.
ENERGY_DB_LO = -30.0
ENERGY_DB_HI = -6.0


def rms_dbfs(rms):
    import math

    return 20.0 * math.log10(max(float(rms), 1e-9))


def energy_from_db(db):
    return clamp01((float(db) - ENERGY_DB_LO) / (ENERGY_DB_HI - ENERGY_DB_LO))


def energy(db, arousal=None):
    """Loudness alone saturates on modern masters; blend in the model's
    arousal (0..1) when there is one."""
    loud = energy_from_db(db)
    if arousal is None:
        return loud
    return clamp01(0.35 * loud + 0.65 * float(arousal))


def normalize_key(key):
    """Essentia keys look like 'C', 'F#', 'Bb'; return None when not A-G with optional #/b."""
    import re

    k = str(key or "")
    return k if re.fullmatch(r"[A-G][#b]?", k) else None


def middle_window(n_samples, sr, seconds=90):
    """(start, end) sample indexes of up to [seconds] taken from the middle."""
    want = int(sr * seconds)
    if n_samples <= want:
        return 0, n_samples
    start = (n_samples - want) // 2
    return start, start + want
