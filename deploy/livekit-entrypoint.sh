#!/bin/sh
# Generates LiveKit config from environment (no secrets in the image/repo).
set -eu

: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is required}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET is required}"

RTC_START="${LIVEKIT_RTC_PORT_START:-50000}"
RTC_END="${LIVEKIT_RTC_PORT_END:-50100}"
USE_EXTERNAL_IP="${LIVEKIT_USE_EXTERNAL_IP:-true}"
LOG_LEVEL="${LIVEKIT_LOG_LEVEL:-info}"
REDIS_ADDR="${LIVEKIT_REDIS_ADDRESS:-redis:6379}"

CONFIG_PATH="${LIVEKIT_CONFIG_PATH:-/tmp/livekit.yaml}"

{
  echo "port: 7880"
  echo "rtc:"
  echo "  tcp_port: 7881"
  echo "  port_range_start: ${RTC_START}"
  echo "  port_range_end: ${RTC_END}"
  echo "  use_external_ip: ${USE_EXTERNAL_IP}"
  if [ -n "${LIVEKIT_NODE_IP:-}" ]; then
    echo "  node_ip: ${LIVEKIT_NODE_IP}"
  fi
  echo "redis:"
  echo "  address: ${REDIS_ADDR}"
  echo "keys:"
  # YAML key may need quoting if it contains special characters.
  echo "  \"${LIVEKIT_API_KEY}\": \"${LIVEKIT_API_SECRET}\""
  echo "logging:"
  echo "  level: ${LOG_LEVEL}"
} > "${CONFIG_PATH}"

exec /livekit-server --config "${CONFIG_PATH}"
