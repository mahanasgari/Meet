# syntax=docker/dockerfile:1
# Audio analyzer for mirror servers (see README.md). x86_64 only (essentia-tensorflow wheel).
FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir essentia-tensorflow numpy requests

# Models from https://essentia.upf.edu/models/ (all URLs checked to exist 2026-11).
# Change MODEL_BASE to use a mirror. emomusic (valence/arousal) is optional:
# the analyzer skips it when its files are absent.
ARG MODEL_BASE=https://essentia.upf.edu/models
RUN mkdir -p /models && cd /models && set -e; \
    dl() { curl -fsSL --retry 3 -O "$MODEL_BASE/$1"; }; \
    dl feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb; \
    dl feature-extractors/musicnn/msd-musicnn-1.pb; \
    for h in mood_happy mood_sad mood_relaxed mood_aggressive mood_party danceability mood_acoustic mood_electronic voice_instrumental genre_discogs400; do \
      dl classification-heads/$h/$h-discogs-effnet-1.pb; \
      dl classification-heads/$h/$h-discogs-effnet-1.json; \
    done; \
    dl classification-heads/emomusic/emomusic-msd-musicnn-2.pb; \
    dl classification-heads/emomusic/emomusic-msd-musicnn-2.json; \
    ls -l /models

WORKDIR /app
COPY mapping.py analyzer.py ./

ENV PYTHONUNBUFFERED=1 MODELS_DIR=/models
RUN useradd -r -u 10001 analyzer
USER analyzer
CMD ["python", "analyzer.py"]
