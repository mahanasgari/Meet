#!/usr/bin/env python3
"""Audio analyzer: leases songs from the home music-bot, analyzes them with
Essentia models and posts the features back. One song at a time, one thread.

Env (same names/credential as the music-bot archive workers):
  HOME_URL           home server base, e.g. https://music.cloudproducts.ir/extractor
  MUSIC_API_TOKEN    shared server secret (Bearer)
  ARCHIVE_SERVER_ID  name of this server in the logs/db (default: hostname)
  MODELS_DIR         where the .pb/.json models live (default /models)
  ANALYZER_BATCH     jobs per lease (default 2), ANALYZER_IDLE_S (default 20)
"""
import os

# One CPU thread everywhere; must be set before TensorFlow loads.
for _k in ("TF_NUM_INTRAOP_THREADS", "TF_NUM_INTEROP_THREADS", "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ.setdefault(_k, "1")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import json
import socket
import subprocess
import sys
import tempfile
import time

import mapping

HOME_URL = os.environ.get("HOME_URL", "").rstrip("/")
TOKEN = os.environ.get("MUSIC_API_TOKEN", "")
SERVER = os.environ.get("ARCHIVE_SERVER_ID") or socket.gethostname()
MODELS = os.environ.get("MODELS_DIR", "/models")
BATCH = max(1, min(int(os.environ.get("ANALYZER_BATCH", "2")), 5))
IDLE_S = float(os.environ.get("ANALYZER_IDLE_S", "20"))
MAX_BYTES = 30 * 1024 * 1024
SR = 16000
MODEL_TAG = "discogs-effnet-1+msd-musicnn-2"

# head name -> (model file stem, key in the result)
EFFNET_HEADS = {
    "happy": "mood_happy",
    "sad": "mood_sad",
    "relaxed": "mood_relaxed",
    "aggressive": "mood_aggressive",
    "party": "mood_party",
    "danceability": "danceability",
    "acoustic": "mood_acoustic",
    "electronic": "mood_electronic",
    "instrumental": "voice_instrumental",
}


def log(msg):
    print(f"[analyzer] {msg}", flush=True)


def _model(name):
    return os.path.join(MODELS, name)


def _schema(stem):
    with open(_model(stem + ".json")) as f:
        return json.load(f)


class Models:
    """Loads every model once."""

    def __init__(self):
        import essentia.standard as es

        self.es = es
        self.effnet = es.TensorflowPredictEffnetDiscogs(
            graphFilename=_model("discogs-effnet-bs64-1.pb"), output="PartitionedCall:1"
        )
        self.heads = {}  # key -> (algo, column)
        for key, stem in EFFNET_HEADS.items():
            full = f"{stem}-discogs-effnet-1"
            js = _schema(full)
            col = mapping.class_column(js["classes"], mapping.POSITIVE[key])
            algo = es.TensorflowPredict2D(
                graphFilename=_model(full + ".pb"),
                input=js["schema"]["inputs"][0]["name"],
                output=js["schema"]["outputs"][0]["name"],
            )
            self.heads[key] = (algo, col)
        gjs = _schema("genre_discogs400-discogs-effnet-1")
        self.genre_labels = gjs["classes"]
        self.genre = es.TensorflowPredict2D(
            graphFilename=_model("genre_discogs400-discogs-effnet-1.pb"),
            input=gjs["schema"]["inputs"][0]["name"],
            output=gjs["schema"]["outputs"][0]["name"],
        )
        # valence/arousal are optional: skipped when the files are missing.
        self.musicnn = self.emo = None
        try:
            ejs = _schema("emomusic-msd-musicnn-2")
            self.emo_cols = (ejs["classes"].index("valence"), ejs["classes"].index("arousal"))
            self.musicnn = es.TensorflowPredictMusiCNN(
                graphFilename=_model("msd-musicnn-1.pb"), output="model/dense/BiasAdd"
            )
            self.emo = es.TensorflowPredict2D(
                graphFilename=_model("emomusic-msd-musicnn-2.pb"),
                input=ejs["schema"]["inputs"][0]["name"],
                output=ejs["schema"]["outputs"][0]["name"],
            )
        except (OSError, KeyError, ValueError, RuntimeError) as e:
            log(f"valence/arousal disabled: {e}")
            self.musicnn = self.emo = None


def fetch_audio(session, video_id, dest):
    """Streams the stored song from home into [dest] (first 30 MB at most)."""
    r = session.get(
        f"{HOME_URL}/analysis/audio",
        params={"id": video_id},
        headers={"Range": f"bytes=0-{MAX_BYTES - 1}"},
        stream=True,
        timeout=(10, 60),
    )
    try:
        if r.status_code not in (200, 206):
            raise RuntimeError(f"audio HTTP {r.status_code}")
        n = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(256 * 1024):
                n += len(chunk)
                if n > MAX_BYTES:
                    break
                f.write(chunk)
        if n == 0:
            raise RuntimeError("empty audio")
    finally:
        r.close()


def decode(path, duration_s):
    """16 kHz mono float32 samples (up to 90 s from the middle) as a numpy array."""
    import numpy as np

    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if duration_s and duration_s > 100:
        cmd += ["-ss", f"{(duration_s - 90) / 2:.2f}", "-t", "90"]
    else:
        cmd += ["-t", "900"]
    cmd += ["-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if p.returncode != 0 and not p.stdout:
        raise RuntimeError("ffmpeg: " + p.stderr.decode(errors="replace")[-200:])
    audio = np.frombuffer(p.stdout, dtype=np.float32)
    s, e = mapping.middle_window(len(audio), SR, 90)
    audio = np.ascontiguousarray(audio[s:e])
    if len(audio) < SR * 5:
        raise RuntimeError("audio too short")
    return audio


def analyze(models, audio):
    import numpy as np

    es = models.es
    out = {"model": MODEL_TAG}

    emb = models.effnet(audio)
    for key, (algo, col) in models.heads.items():
        out[key] = mapping.mean_column(algo(emb), col)
    gp = np.mean(models.genre(emb), axis=0)
    out["genres"] = mapping.top_genres(gp, models.genre_labels, k=3, min_p=0.1)

    if models.emo is not None:
        va = models.emo(models.musicnn(audio))
        v, a = (float(np.mean(va[:, c])) for c in models.emo_cols)
        out["valence"], out["arousal"] = mapping.scale_emo(v), mapping.scale_emo(a)

    # Classic descriptors: tempo and key want 44.1 kHz.
    audio44 = es.Resample(inputSampleRate=SR, outputSampleRate=44100)(audio)
    bpm = float(es.RhythmExtractor2013(method="multifeature")(audio44)[0])
    if 30 <= bpm <= 300:
        out["bpm"] = round(bpm, 1)
    key, scale, strength = es.KeyExtractor()(audio44)
    k = mapping.normalize_key(key)
    if k and scale in ("major", "minor"):
        out["key"], out["scale"], out["keyStrength"] = k, scale, mapping.clamp01(strength)

    # Energy: RMS loudness (-30..-6 dBFS → 0..1) blended with arousal.
    rms = float(np.sqrt(np.mean(np.square(audio.astype(np.float64)))))
    db = mapping.rms_dbfs(rms)
    out["loudness"] = round(db, 2)
    out["energy"] = round(mapping.energy(db, out.get("arousal")), 4)
    return out


class Home:
    def __init__(self):
        import requests

        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {TOKEN}", "X-MP-Server": SERVER[:40]})

    def post(self, path, body):
        r = self.s.post(f"{HOME_URL}{path}", json=body, timeout=30)
        if r.status_code == 400:
            return r  # bad result: do not retry, caller reports
        r.raise_for_status()
        return r

    def lease(self):
        return self.post("/analysis/lease", {"n": BATCH}).json().get("jobs", [])


def run_one(home, models, job):
    vid = job["videoId"]
    t0 = time.time()
    fd, path = tempfile.mkstemp(prefix="an-", suffix=".audio")
    os.close(fd)
    try:
        fetch_audio(home.s, vid, path)
        t1 = time.time()
        audio = decode(path, job.get("durationS"))
        t2 = time.time()
        result = analyze(models, audio)
        t3 = time.time()
        r = home.post("/analysis/result", {"videoId": vid, **result})
        if r.status_code == 400:
            raise RuntimeError(f"home rejected result: {r.text[:120]}")
        log(f"{vid} ok bpm={result.get('bpm')} key={result.get('key')} {result.get('scale')} "
            f"fetch={t1 - t0:.1f}s decode={t2 - t1:.1f}s analyze={t3 - t2:.1f}s total={time.time() - t0:.1f}s")
    except Exception as e:  # noqa: BLE001 - every failure is reported home
        msg = f"{type(e).__name__}: {e}"[:300]
        log(f"{vid} FAILED {msg} after {time.time() - t0:.1f}s")
        try:
            home.post("/analysis/result", {"videoId": vid, "error": msg})
        except Exception as e2:  # noqa: BLE001
            log(f"{vid} could not report error: {e2}")  # lease expires, song re-offered
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def main():
    if not HOME_URL or not TOKEN:
        sys.exit("HOME_URL and MUSIC_API_TOKEN are required")
    try:
        os.nice(10)
    except OSError:
        pass
    log(f"loading models from {MODELS}")
    models = Models()
    home = Home()
    log(f"ready as {SERVER}, home {HOME_URL}")
    while True:
        try:
            jobs = home.lease()
        except Exception as e:  # noqa: BLE001
            log(f"lease failed: {e}")
            jobs = []
        if not jobs:
            time.sleep(IDLE_S)
            continue
        for job in jobs:
            run_one(home, models, job)


if __name__ == "__main__":
    main()
