#!/usr/bin/env bash
# Print a fresh LiveKit API key/secret pair for .env
set -euo pipefail
echo "LIVEKIT_API_KEY=$(openssl rand -hex 16)"
echo "LIVEKIT_API_SECRET=$(openssl rand -hex 32)"
