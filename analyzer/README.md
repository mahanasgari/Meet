# music-analyzer

Leases stored songs from the home music-bot, analyzes them with Essentia
(BPM, key/scale, energy/loudness, mood, danceability, acoustic/electronic,
instrumental, valence/arousal, top genres) and posts the result back. Runs on
mirror servers, one song at a time, one thread, nice 10.

## How it talks to home

Same credential as the music-bot archive workers: `MUSIC_API_TOKEN` (Bearer)
and `HOME_URL` (workers use `https://music.cloudproducts.ir/extractor`).

- `POST $HOME_URL/analysis/lease {n}` -> `{jobs:[{videoId,durationS}]}` (30 min lease)
- `GET  $HOME_URL/analysis/audio?id=VIDEO_ID` stored audio (disk copy or the
  Telegram channel; never YouTube, no play counted); the analyzer asks for the first 30 MB
- `POST $HOME_URL/analysis/result {videoId, bpm, key, scale, ..., genres}` or `{videoId, error}`

## Env

| var | meaning |
|---|---|
| `HOME_URL`, `MUSIC_API_TOKEN` | required; from the mirror's music-bot env file |
| `ARCHIVE_SERVER_ID` | server name recorded with results (default: hostname) |
| `ANALYZER_BATCH` | jobs per lease, default 2 |
| `ANALYZER_IDLE_S` | sleep when no jobs, default 20 |
| `MODELS_DIR` | default `/models` (baked into the image) |

## Run

    docker build -t music-analyzer analyzer/
    docker run -d --name music-analyzer --restart unless-stopped --memory 900m --cpus 0.8 \
      --env-file /root/music-bot.current.env music-analyzer

or `docker compose -f deploy/analyzer-compose.yml up -d`. Image:
`ghcr.io/mahanasgari/music-analyzer:latest` (built by `.github/workflows/analyzer-image.yml`).
x86_64 only.

## Mappings

- Heads output `[class_a, class_b]`; the positive column is looked up from each model's `.json` `classes`.
- Valence/arousal (emomusic, 1..9) -> `(x-1)/8`. Skipped if the model files are missing.
- Energy: RMS dBFS of the analyzed window, -40 dB -> 0, -10 dB -> 1. `loudness` is that RMS in dBFS.
- BPM/key run on the 16 kHz audio resampled to 44.1 kHz.

## Test

    cd analyzer && python3 -m unittest test_mapping
